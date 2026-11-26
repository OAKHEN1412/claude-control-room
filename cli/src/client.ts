// WebSocket client of the Control Room server. Keeps the latest snapshot / session / runner state and matches acks to
// requests by reqId. A Node client sends no Origin header, which the server accepts (browsers need a loopback one).
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AccountInfo } from '../../shared/accounts.ts';
import type { RunnerState, SavedSession, ServerMsg, SessionInfo } from '../../shared/protocol.ts';

export interface Ack {
  ok: boolean;
  error?: string;
  sessionId?: string;
  answer?: string;
}

export interface State {
  sessions: Map<string, SessionInfo>;
  runners: Map<string, RunnerState>;
  saved: SavedSession[];
  cwds: string[];
  accounts: AccountInfo[];
  defaultAccountId: string;
}

export function emptyState(): State {
  return { sessions: new Map(), runners: new Map(), saved: [], cwds: [], accounts: [], defaultAccountId: '' };
}

/** Applies one server message to the state. Returns true when the message changed it. */
export function applyMessage(st: State, msg: ServerMsg): boolean {
  switch (msg.type) {
    case 'snapshot':
      st.sessions = new Map(msg.sessions.map((s) => [s.sessionId, s]));
      st.runners = new Map((msg.runners ?? []).map((r) => [r.sessionId, r]));
      if (msg.saved) st.saved = msg.saved;
      if (msg.cwds) st.cwds = msg.cwds;
      if (msg.accounts) st.accounts = msg.accounts;
      if (msg.defaultAccountId !== undefined) st.defaultAccountId = msg.defaultAccountId;
      return true;
    case 'accounts':
      st.accounts = msg.accounts;
      st.defaultAccountId = msg.defaultId;
      return true;
    case 'session':
      st.sessions.set(msg.session.sessionId, msg.session);
      return true;
    case 'removed':
      return st.sessions.delete(msg.sessionId);
    case 'runner':
      st.runners.set(msg.runner.sessionId, msg.runner);
      return true;
    case 'runner_removed':
      return st.runners.delete(msg.sessionId);
    case 'saved':
      st.saved = msg.sessions;
      return true;
    case 'cwds':
      st.cwds = msg.cwds;
      return true;
    default:
      return false;
  }
}

export interface CrClientOptions {
  /** `cr_session=<sid>` from the app-lock unlock. Sent as the WebSocket Cookie header. Kept in memory only. */
  cookie?: string;
}

export class CrClient extends EventEmitter {
  readonly state: State = emptyState();
  private ws: WebSocket | null = null;
  readonly cookie: string | undefined;
  private n = 0;
  private readonly waiting = new Map<string, { resolve: (a: Ack) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly port: number;

  constructor(port: number, opts: CrClientOptions = {}) {
    super();
    this.port = port;
    this.cookie = opts.cookie;
  }

  /** Resolves after the first snapshot; rejects when the server cannot be reached. */
  connect(timeoutMs = 4000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, this.cookie ? { headers: { Cookie: this.cookie } } : undefined);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(new Error('timeout'));
      }, timeoutMs);
      ws.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg: ServerMsg;
        try {
          msg = JSON.parse(data.toString('utf8')) as ServerMsg;
        } catch {
          return;
        }
        if (msg.type === 'ack') {
          const w = this.waiting.get(msg.reqId);
          if (w) {
            clearTimeout(w.timer);
            this.waiting.delete(msg.reqId);
            w.resolve({ ok: msg.ok, error: msg.error, sessionId: msg.sessionId, answer: msg.answer });
          }
          return;
        }
        const changed = applyMessage(this.state, msg);
        if (msg.type === 'snapshot' && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
        if (changed) this.emit('change', msg);
      });
      ws.on('close', (code: number) => {
        for (const [id, w] of this.waiting) {
          clearTimeout(w.timer);
          w.resolve({ ok: false, error: 'การเชื่อมต่อหลุด' });
          this.waiting.delete(id);
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(Object.assign(new Error('closed'), { code })); // 4401 = app lock, see auth.ts
        }
        this.emit('close');
      });
    });
  }

  /** Sends a command and resolves with its ack (ok:false with an error text on failure or timeout). */
  send(cmd: Record<string, unknown>, timeoutMs = 20_000): Promise<Ack> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: 'ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์' });
    const reqId = `cr${Date.now().toString(36)}-${++this.n}`;
    return new Promise<Ack>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        resolve({ ok: false, error: 'เซิร์ฟเวอร์ไม่ตอบ' });
      }, timeoutMs);
      this.waiting.set(reqId, { resolve, timer });
      ws.send(JSON.stringify({ ...cmd, reqId }));
    });
  }

  close(): void {
    this.ws?.close();
  }
}
