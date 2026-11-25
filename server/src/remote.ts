// Remote hub: sees and commands the Claude sessions of other PCs through the Control Room agent running there.
// Per machine with `agent: true` it keeps (1) an SSH local port forward 127.0.0.1:<free> -> 127.0.0.1:8791 on the
// machine (a child `ssh -N`, killed only by its own handle) and (2) a websocket to the forwarded port that carries the
// shared token. The agent's snapshot / session / runner messages are re-stamped with the machine id and handed to the
// main server, which broadcasts them to browsers; commands go the other way with their own reqId and the ack is relayed.
// Dev switch CR_REMOTE_DIRECT=1 skips the SSH hop (127.0.0.1:<port> directly). Tokens are never logged or stored here.
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { WebSocket } from 'ws';
import { AGENT_PORT, AGENT_TOKEN_HEADER, type AgentState, type ClientMsg, type RunnerState, type SavedSession, type ServerMsg, type SessionInfo, type VarMap } from '../../shared/protocol';
import { keyUnderSsh } from './machines';
import { CommandError } from './runner';

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const FORWARD_WAIT_MS = 15_000;
export const SILENCE_MS = 20_000; // the agent pings every 5 s; no frame for this long = dead link
export const ACK_TIMEOUT_MS = 30_000;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

/** What the hub needs of a machine row. */
export interface RemoteTarget {
  id: string;
  name: string;
  host: string;
  user: string;
  keyPath: string;
  agent: boolean;
}

/** The slice of a ws WebSocket the hub uses (real `ws` instances and test fakes both fit). */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

/** The slice of a ChildProcess the hub uses for the tunnel. */
export interface TunnelChild {
  kill(): boolean | void;
  on(event: string, cb: (...args: any[]) => void): unknown;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
}

export interface RemoteDeps {
  machines: () => RemoteTarget[];
  /** Token of a machine's agent. Wired to the vault by the caller; the hub never logs it. */
  getToken: (machineId: string) => string | null | Promise<string | null>;
  sshDir?: string;
  agentPort?: number; // port on the remote machine, default 8791
  /** CR_REMOTE_DIRECT dev switch: connect straight to 127.0.0.1:<port>, no ssh. */
  direct?: { port: number } | null;
  spawn?: (file: string, args: string[]) => TunnelChild;
  openWs?: (url: string, headers: Record<string, string>) => WsLike;
  freePort?: () => Promise<number>;
  /** Resolves true once something accepts connections on 127.0.0.1:port. */
  portReady?: (port: number) => Promise<boolean>;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  ackTimeoutMs?: number;
  silenceMs?: number;
  forwardWaitMs?: number;
}

export interface RemoteStatus {
  state: AgentState;
  error?: string;
  code?: string; // srv.* code of `error`
  vars?: VarMap; // values for the {name} placeholders of `code`
  cwds?: string[];
}

type Ack = Extract<ServerMsg, { type: 'ack' }>;

/** Argument array of the tunnel (exported for tests). No shell is involved: this goes to spawn() as an array. */
export function buildTunnelArgs(t: Pick<RemoteTarget, 'host' | 'user' | 'keyPath'>, localPort: number, remotePort: number = AGENT_PORT): string[] {
  return [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-i', t.keyPath,
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    `${t.user}@${t.host}`,
  ];
}

/** Env var that holds the token of a machine: CR_AGENT_TOKEN_<ID upper-cased, non-alphanumerics -> _>. */
export function tokenEnvName(machineId: string): string {
  return `CR_AGENT_TOKEN_${machineId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Default token source: the machine's env var; with the direct dev switch also plain CR_AGENT_TOKEN. */
export function envTokenSource(env: NodeJS.ProcessEnv, direct: boolean): (machineId: string) => string | null {
  return (id) => {
    const v = env[tokenEnvName(id)] || (direct ? env.CR_AGENT_TOKEN : undefined);
    return v && v.trim() !== '' ? v.trim() : null;
  };
}

/** Pulls the agent token out of `secrets get` output: the first line that is 32-128 url-safe chars. */
export function parseAgentToken(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim();
    if (/^[A-Za-z0-9_-]{32,128}$/.test(t)) return t;
  }
  return null;
}

/** CR_REMOTE_DIRECT=1 -> { port: CR_REMOTE_DIRECT_PORT || 8791 }. Off by default. */
export function directFromEnv(env: NodeJS.ProcessEnv): { port: number } | null {
  if (env.CR_REMOTE_DIRECT !== '1') return null;
  const p = Number(env.CR_REMOTE_DIRECT_PORT);
  return { port: Number.isInteger(p) && p > 0 && p < 65536 ? p : AGENT_PORT };
}

const defaultFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });

const defaultPortReady = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1000, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class Conn {
  readonly sessions = new Map<string, SessionInfo>();
  readonly runners = new Map<string, RunnerState>();
  saved: SavedSession[] = [];
  cwds: string[] = [];
  state: AgentState = 'connecting';
  error: string | undefined;
  errorCode: string | undefined;
  errorVars: VarMap | undefined;
  child: TunnelChild | null = null;
  ws: WsLike | null = null;
  timer: NodeJS.Timeout | null = null;
  watchdog: NodeJS.Timeout | null = null;
  delay: number;
  stopped = false;
  gen = 0; // bumped on every (re)connect so late callbacks of an older attempt are ignored
  lastFrame = 0;
  tunnelErr = '';
  pending = new Map<string, { resolve: (a: Ack) => void; timer: NodeJS.Timeout }>();
  constructor(
    public target: RemoteTarget,
    public sig: string,
    delay: number,
  ) {
    this.delay = delay;
  }
}

export class RemoteHub extends EventEmitter {
  private readonly d: RemoteDeps;
  private readonly conns = new Map<string, Conn>();
  private readonly now: () => number;
  private n = 0;
  private stoppedAll = false;

  /**
   * Events:
   *  'session' (SessionInfo)            a remote session was added or changed (machineId set)
   *  'removed' (machineId, sessionId)
   *  'runner' (RunnerState)            machineId set
   *  'runner_removed' (machineId, sessionId)
   *  'saved' ()                         the remembered-session list of some machine changed (read with savedAll())
   *  'status' (machineId, RemoteStatus | null)
   */
  constructor(deps: RemoteDeps) {
    super();
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  // ----- lifecycle -----

  /** Makes the connections match the machine list: new agent machines connect, changed ones restart, others stop. */
  sync(): void {
    if (this.stoppedAll) return;
    const wanted = new Map<string, RemoteTarget>();
    for (const m of this.d.machines()) if (m.agent) wanted.set(m.id, m);
    for (const [id, c] of [...this.conns]) {
      const w = wanted.get(id);
      if (!w || c.sig !== this.sig(w)) this.drop(id);
    }
    for (const [id, t] of wanted) {
      if (this.conns.has(id)) continue;
      const c = new Conn(t, this.sig(t), this.d.backoffMinMs ?? BACKOFF_MIN_MS);
      this.conns.set(id, c);
      this.emit('status', id, this.statusOf(c));
      void this.connect(c);
    }
  }

  /** Tear down everything (server stop). Only the ssh children this hub spawned are killed, each by its own handle. */
  stop(): void {
    this.stoppedAll = true;
    for (const id of [...this.conns.keys()]) this.drop(id);
  }

  private sig(t: RemoteTarget): string {
    return JSON.stringify([t.host, t.user, t.keyPath]);
  }

  /** Forget a machine: stop its tunnel + socket and remove its sessions from the view. */
  private drop(id: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    c.stopped = true;
    this.teardown(c);
    this.conns.delete(id);
    this.emit('status', id, null);
  }

  private statusOf(c: Conn): RemoteStatus {
    return {
      state: c.state,
      ...(c.error ? { error: c.error } : {}),
      ...(c.errorCode ? { code: c.errorCode } : {}),
      ...(c.errorVars ? { vars: c.errorVars } : {}),
      ...(c.cwds.length ? { cwds: c.cwds } : {}),
    };
  }

  private setState(c: Conn, state: AgentState, error?: string, code?: string, vars?: VarMap): void {
    c.state = state;
    c.error = state === 'error' ? error : undefined;
    c.errorCode = state === 'error' ? code : undefined;
    c.errorVars = state === 'error' ? vars : undefined;
    this.emit('status', c.target.id, this.statusOf(c));
  }

  // ----- connect loop -----

  private teardown(c: Conn): void {
    c.gen++;
    if (c.timer) clearTimeout(c.timer);
    if (c.watchdog) clearInterval(c.watchdog);
    c.timer = null;
    c.watchdog = null;
    const ws = c.ws;
    c.ws = null;
    if (ws) {
      try {
        ws.terminate();
      } catch {
        // already closed
      }
    }
    const child = c.child;
    c.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    for (const [, p] of c.pending) {
      clearTimeout(p.timer);
      p.resolve({ type: 'ack', serverTime: this.now(), reqId: '', ok: false, error: 'ขาดการเชื่อมต่อกับเครื่องปลายทาง', code: 'srv.remote.disconnected' });
    }
    c.pending.clear();
    this.clearView(c);
  }

  /** The machine's sessions leave the view (link lost or machine dropped); a new snapshot brings them back. */
  private clearView(c: Conn): void {
    const mid = c.target.id;
    for (const sid of [...c.sessions.keys()]) this.emit('removed', mid, sid);
    for (const sid of [...c.runners.keys()]) this.emit('runner_removed', mid, sid);
    const hadSaved = c.saved.length > 0;
    c.sessions.clear();
    c.runners.clear();
    c.saved = [];
    if (hadSaved) this.emit('saved');
  }

  private retry(c: Conn, why: string, code?: string, vars?: VarMap): void {
    if (c.stopped || this.stoppedAll) return;
    this.teardown(c);
    this.setState(c, 'error', why, code, vars);
    const wait = c.delay;
    c.delay = Math.min(c.delay * 2, this.d.backoffMaxMs ?? BACKOFF_MAX_MS);
    c.timer = setTimeout(() => void this.connect(c), wait);
    c.timer.unref?.();
  }

  private async connect(c: Conn): Promise<void> {
    if (c.stopped || this.stoppedAll) return;
    const gen = ++c.gen;
    const alive = () => !c.stopped && !this.stoppedAll && c.gen === gen;
    const t = c.target;
    this.setState(c, 'connecting');
    let token: string | null;
    try {
      token = await this.d.getToken(t.id);
    } catch (e) {
      if (alive()) this.retry(c, `อ่าน token ไม่ได้: ${errText(e)}`, 'srv.remote.tokenReadFailed', { err: errText(e) });
      return;
    }
    if (!alive()) return;
    if (!token) {
      this.retry(c, `ยังไม่มี token ของเครื่องนี้ (ตั้ง ${tokenEnvName(t.id)})`, 'srv.remote.tokenMissing', { env: tokenEnvName(t.id) });
      return;
    }
    let port: number;
    if (this.d.direct) {
      port = this.d.direct.port;
    } else {
      if (t.user === '' || t.keyPath === '' || !HOST_RE.test(t.host) || !USER_RE.test(t.user)) {
        this.retry(c, 'เครื่องนี้ยังไม่ได้ตั้งค่า SSH', 'srv.remote.noSsh');
        return;
      }
      if (!keyUnderSsh(t.keyPath, this.d.sshDir)) {
        this.retry(c, 'ไม่พบไฟล์ key ใน ~/.ssh', 'srv.remote.keyMissing');
        return;
      }
      try {
        port = await (this.d.freePort ?? defaultFreePort)();
      } catch (e) {
        if (alive()) this.retry(c, `หาพอร์ตว่างไม่ได้: ${errText(e)}`, 'srv.remote.noPort', { err: errText(e) });
        return;
      }
      if (!alive()) return;
      c.tunnelErr = '';
      let exited = false;
      const child = (this.d.spawn ?? defaultSpawn)('ssh', buildTunnelArgs(t, port, this.d.agentPort ?? AGENT_PORT));
      c.child = child;
      child.stderr?.on('data', (b) => {
        // ssh prints key-exchange / known-hosts warnings on every start; the real reason is the first other line
        const line = String(b).split(/\r?\n/).find((l) => l.trim() !== '' && !/^(\*\*|warning:)/i.test(l.trim()));
        if (line) c.tunnelErr = line.trim().slice(0, 200);
      });
      child.on('error', (e: Error) => {
        exited = true;
        c.tunnelErr = e.message.slice(0, 200);
        if (alive()) this.retry(c, `เปิด SSH ไม่ได้: ${c.tunnelErr}`, 'srv.remote.sshOpenFailed', { err: c.tunnelErr });
      });
      child.on('exit', () => {
        exited = true;
        if (alive()) {
          if (c.tunnelErr !== '') this.retry(c, `SSH หลุด: ${c.tunnelErr}`, 'srv.remote.sshDropped', { err: c.tunnelErr });
          else this.retry(c, 'SSH หลุด', 'srv.remote.sshDroppedPlain');
        }
      });
      // wait for the forward to accept connections (ssh exits instead when the host / key / forward fails)
      const ready = this.d.portReady ?? defaultPortReady;
      const deadline = this.now() + (this.d.forwardWaitMs ?? FORWARD_WAIT_MS);
      let up = false;
      while (alive() && !exited && this.now() < deadline) {
        if (await ready(port)) {
          up = true;
          break;
        }
        await sleep(200);
      }
      if (!alive()) return;
      if (!up) {
        if (!exited) {
          if (c.tunnelErr !== '') this.retry(c, `เชื่อม SSH ไม่ได้: ${c.tunnelErr}`, 'srv.remote.sshConnectFailed', { err: c.tunnelErr });
          else this.retry(c, 'เชื่อม SSH ไม่ได้ (หมดเวลา)', 'srv.remote.sshConnectTimeout');
        }
        return;
      }
    }
    this.openSocket(c, gen, port, token);
  }

  private openSocket(c: Conn, gen: number, port: number, token: string): void {
    const alive = () => !c.stopped && !this.stoppedAll && c.gen === gen;
    let ws: WsLike;
    try {
      ws = (this.d.openWs ?? defaultOpenWs)(`ws://127.0.0.1:${port}`, { [AGENT_TOKEN_HEADER]: token });
    } catch (e) {
      this.retry(c, `เปิด websocket ไม่ได้: ${errText(e)}`, 'srv.remote.wsFailed', { err: errText(e) });
      return;
    }
    c.ws = ws;
    c.lastFrame = this.now();
    let lastErr = '';
    ws.on('error', (e: Error) => {
      lastErr = e.message;
    });
    ws.on('message', (data: Buffer | string) => {
      if (!alive()) return;
      c.lastFrame = this.now();
      this.ingest(c, typeof data === 'string' ? data : data.toString('utf8'));
    });
    ws.on('close', () => {
      if (!alive()) return;
      if (/401/.test(lastErr)) this.retry(c, 'token ไม่ตรงกับเครื่องปลายทาง', 'srv.remote.tokenMismatch');
      else if (/hang up|ECONNRESET|ECONNREFUSED/i.test(lastErr)) {
        this.retry(c, 'ไม่พบ agent บนเครื่องนั้น (ยังไม่ได้ติดตั้ง หรือหยุดทำงาน)', 'srv.remote.agentNotFound');
      } else if (lastErr !== '') this.retry(c, `เชื่อมต่อ agent ไม่ได้: ${lastErr}`, 'srv.remote.agentConnectFailed', { err: lastErr });
      else this.retry(c, 'agent ตัดการเชื่อมต่อ', 'srv.remote.agentClosed');
    });
    c.watchdog = setInterval(() => {
      if (alive() && this.now() - c.lastFrame > (this.d.silenceMs ?? SILENCE_MS)) {
        this.retry(c, 'agent เงียบเกินไป (ลิงก์อาจหลุด)', 'srv.remote.agentSilent');
      }
    }, 5000);
    c.watchdog.unref?.();
  }

  // ----- ingest -----

  private stampSession(c: Conn, s: SessionInfo): SessionInfo {
    return { ...s, machineId: c.target.id };
  }

  private stampRunner(c: Conn, r: RunnerState): RunnerState {
    return { ...r, machineId: c.target.id };
  }

  private stampSaved(c: Conn, s: SavedSession): SavedSession {
    return { ...s, machineId: c.target.id };
  }

  /** One frame from the agent. Unknown / malformed frames are ignored. */
  ingest(c: Conn, raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const mid = c.target.id;
    switch (msg.type) {
      case 'snapshot': {
        if (!Array.isArray(msg.sessions)) return;
        const seen = new Set<string>();
        for (const s of msg.sessions) {
          if (!s || typeof s.sessionId !== 'string') continue;
          seen.add(s.sessionId);
          const st = this.stampSession(c, s);
          c.sessions.set(s.sessionId, st);
          this.emit('session', st);
        }
        for (const sid of [...c.sessions.keys()]) {
          if (!seen.has(sid)) {
            c.sessions.delete(sid);
            this.emit('removed', mid, sid);
          }
        }
        const rseen = new Set<string>();
        for (const r of msg.runners ?? []) {
          if (!r || typeof r.sessionId !== 'string') continue;
          rseen.add(r.sessionId);
          const st = this.stampRunner(c, r);
          c.runners.set(r.sessionId, st);
          this.emit('runner', st);
        }
        for (const sid of [...c.runners.keys()]) {
          if (!rseen.has(sid)) {
            c.runners.delete(sid);
            this.emit('runner_removed', mid, sid);
          }
        }
        c.cwds = Array.isArray(msg.cwds) ? msg.cwds.filter((x) => typeof x === 'string') : c.cwds;
        if (Array.isArray(msg.saved)) {
          c.saved = msg.saved.map((s) => this.stampSaved(c, s));
          this.emit('saved');
        }
        c.delay = this.d.backoffMinMs ?? BACKOFF_MIN_MS; // a snapshot proves the whole path works
        this.setState(c, 'online');
        return;
      }
      case 'session': {
        const s = msg.session;
        if (!s || typeof s.sessionId !== 'string') return;
        const st = this.stampSession(c, s);
        c.sessions.set(s.sessionId, st);
        this.emit('session', st);
        return;
      }
      case 'removed':
        if (typeof msg.sessionId === 'string' && c.sessions.delete(msg.sessionId)) this.emit('removed', mid, msg.sessionId);
        return;
      case 'runner': {
        const r = msg.runner;
        if (!r || typeof r.sessionId !== 'string') return;
        const st = this.stampRunner(c, r);
        c.runners.set(r.sessionId, st);
        this.emit('runner', st);
        return;
      }
      case 'runner_removed':
        if (typeof msg.sessionId === 'string' && c.runners.delete(msg.sessionId)) this.emit('runner_removed', mid, msg.sessionId);
        return;
      case 'cwds':
        if (Array.isArray(msg.cwds)) {
          c.cwds = msg.cwds.filter((x) => typeof x === 'string');
          this.emit('status', mid, this.statusOf(c));
        }
        return;
      case 'saved':
        if (Array.isArray(msg.sessions)) {
          c.saved = msg.sessions.map((s) => this.stampSaved(c, s));
          this.emit('saved');
        }
        return;
      case 'ack': {
        const p = c.pending.get(msg.reqId);
        if (!p) return;
        clearTimeout(p.timer);
        c.pending.delete(msg.reqId);
        p.resolve(msg);
        return;
      }
      default:
        return; // ping, worklog, ... nothing to do
    }
  }

  // ----- views -----

  /** Test helper and index.ts: the connection of a machine (undefined when it has no agent). */
  conn(machineId: string): Conn | undefined {
    return this.conns.get(machineId);
  }

  sessions(): SessionInfo[] {
    return [...this.conns.values()].flatMap((c) => [...c.sessions.values()]);
  }

  runners(): RunnerState[] {
    return [...this.conns.values()].flatMap((c) => [...c.runners.values()]);
  }

  savedAll(): SavedSession[] {
    return [...this.conns.values()].flatMap((c) => c.saved);
  }

  status(machineId: string): RemoteStatus | null {
    const c = this.conns.get(machineId);
    return c ? this.statusOf(c) : null;
  }

  has(machineId: string): boolean {
    return this.conns.has(machineId);
  }

  /** Machine that owns a remote session (by session id), or null. */
  machineOf(sessionId: string): string | null {
    for (const [id, c] of this.conns) if (c.sessions.has(sessionId) || c.runners.has(sessionId)) return id;
    return null;
  }

  // ----- commands -----

  /**
   * Sends a validated command to the agent of `machineId` under a fresh reqId and resolves with the agent's ack
   * (reqId restored by the caller). `machineId` itself is never forwarded. Rejects with a CommandError when the
   * machine has no agent or the link is down.
   */
  forward(machineId: string, msg: ClientMsg): Promise<Ack> {
    const c = this.conns.get(machineId);
    if (!c) return Promise.reject(new CommandError('เครื่องนี้ไม่ได้เปิด "ดู Claude บนเครื่องนี้"', 'srv.remote.agentOff'));
    const ws = c.ws;
    if (c.state !== 'online' || !ws || ws.readyState !== WebSocket.OPEN) {
      const text = `เครื่อง ${c.target.name} ยังไม่เชื่อมต่อ (${c.state === 'error' ? (c.error ?? 'ผิดพลาด') : 'กำลังเชื่อมต่อ'})`;
      const code = c.state === 'error' ? 'srv.remote.notConnectedError' : 'srv.remote.notConnectedBusy';
      return Promise.reject(new CommandError(text, code, { name: c.target.name, detail: c.state === 'error' ? (c.error ?? 'ผิดพลาด') : '' }));
    }
    const reqId = `f${this.now().toString(36)}-${++this.n}`;
    return new Promise<Ack>((resolve) => {
      const timer = setTimeout(() => {
        c.pending.delete(reqId);
        resolve({ type: 'ack', serverTime: this.now(), reqId, ok: false, error: 'เครื่องปลายทางไม่ตอบ', code: 'srv.remote.noReply' });
      }, this.d.ackTimeoutMs ?? ACK_TIMEOUT_MS);
      timer.unref?.();
      c.pending.set(reqId, { resolve, timer });
      try {
        const { machineId: _drop, ...rest } = msg as ClientMsg & { machineId?: string };
        ws.send(JSON.stringify({ ...rest, reqId }));
      } catch (e) {
        clearTimeout(timer);
        c.pending.delete(reqId);
        resolve({ type: 'ack', serverTime: this.now(), reqId, ok: false, error: errText(e) });
      }
    });
  }
}

function defaultSpawn(file: string, args: string[]): TunnelChild {
  return nodeSpawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
}

function defaultOpenWs(url: string, headers: Record<string, string>): WsLike {
  return new WebSocket(url, { headers, handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 }) as unknown as WsLike;
}
