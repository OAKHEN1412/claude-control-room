// Machines: other PCs on Tailscale that a web job can work on over SSH. Rows live in SQLite (table machines);
// reachability (TCP :22), the ssh test result and the job attachments are in memory. The server never reads a key
// file and never stores a password: only the key's path, which must lie under ~/.ssh.
import { execFile as nodeExecFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MACHINE_SHELLS, type AgentState, type MachineAttachment, type MachineFields, type MachineInfo, type MachineShell, type TailscalePeer } from '../../shared/protocol';
import type { MachineRow, WorklogDb } from './db';
import { CommandError } from './runner';

export const PROBE_MS = 30_000;
export const PEERS_MS = 60_000;
export const PROBE_TIMEOUT_MS = 2000;
export const TEST_TIMEOUT_MS = 10_000;
export const NAME_MAX = 40;
export const NOTES_MAX = 300;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const USER_RE = /^[A-Za-z0-9._-]{0,64}$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/;

/** No built-in machines: they are added through the UI. (Seeding only runs on an empty table.) */
export const SEED_MACHINES: readonly Omit<MachineRow, 'created'>[] = [];

/** Shape checks that need no file system (shared with commands.ts). Returns a Thai error or null. */
export function checkMachineShape(input: object): string | null {
  const f = input as Record<string, unknown>;
  if (typeof f.name !== 'string' || f.name.trim().length < 1 || f.name.trim().length > NAME_MAX || CTRL_RE.test(f.name)) return 'ชื่อเครื่องต้องยาว 1-40 ตัวอักษร';
  // a leading '-' would make ssh read the host or user as an option
  if (typeof f.host !== 'string' || !HOST_RE.test(f.host) || f.host.startsWith('-') || f.host.startsWith('.')) return 'host ไม่ถูกต้อง (IP หรือชื่อเครื่อง)';
  if (typeof f.user !== 'string' || !USER_RE.test(f.user) || f.user.startsWith('-')) return 'user ไม่ถูกต้อง';
  if (typeof f.keyPath !== 'string' || f.keyPath.length > 500 || CTRL_RE.test(f.keyPath)) return 'key path ไม่ถูกต้อง';
  if (typeof f.shell !== 'string' || !(MACHINE_SHELLS as readonly string[]).includes(f.shell)) return 'shell ต้องเป็น cmd, powershell หรือ bash';
  if (f.notes !== undefined && (typeof f.notes !== 'string' || f.notes.length > NOTES_MAX)) return 'หมายเหตุยาวเกินไป';
  if (f.agent !== undefined && typeof f.agent !== 'boolean') return 'agent ต้องเป็น true หรือ false';
  return null;
}

/** True when `keyPath` is a file under `sshDir` (default ~/.ssh), also through symlinks. Never reads the file. */
export function keyUnderSsh(keyPath: string, sshDir: string = path.join(os.homedir(), '.ssh')): boolean {
  if (keyPath.trim() === '') return false;
  const rootAbs = path.resolve(sshDir);
  const abs = path.resolve(resolveTilde(keyPath));
  const inside = (root: string, p: string): boolean => {
    const rel = path.relative(root.toLowerCase(), p.toLowerCase());
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (!inside(rootAbs, abs)) return false;
  try {
    if (!inside(fs.realpathSync(rootAbs), fs.realpathSync(abs))) return false;
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function resolveTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ---------- Tailscale ----------

/** Peers from `tailscale status --json` (Self is left out: the local machine is not a row). */
export function parseTailscalePeers(json: string): TailscalePeer[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const peerMap = (data as { Peer?: unknown } | null)?.Peer;
  if (!peerMap || typeof peerMap !== 'object') return [];
  const out: TailscalePeer[] = [];
  for (const v of Object.values(peerMap as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const p = v as { HostName?: unknown; TailscaleIPs?: unknown; OS?: unknown; Online?: unknown };
    if (typeof p.HostName !== 'string' || p.HostName === '') continue;
    const ips = Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs.filter((x): x is string => typeof x === 'string') : [];
    const ip = ips.find((x) => net.isIPv4(x));
    if (!ip) continue;
    out.push({ name: p.HostName.toLowerCase(), ip, os: typeof p.OS === 'string' ? p.OS : '', online: p.Online === true });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type ExecFileFn = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
export type ConnectFn = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

const defaultExecFile: ExecFileFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { timeout: opts.timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { stdout?: string; stderr?: string };
        e.stdout = String(stdout ?? '');
        e.stderr = String(stderr ?? '');
        reject(e);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });

export const defaultConnect: ConnectFn = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });

// ---------- attach / detach texts ----------

function shellQuote(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

export function attachMessage(m: Pick<MachineRow, 'name' | 'host' | 'user' | 'keyPath' | 'shell' | 'notes'>): string {
  const lines = [
    `[เชื่อมเครื่อง ${m.name}]`,
    `คุณทำงานบนเครื่อง ${m.name} (${m.host}) ได้ผ่าน SSH:`,
    `  ssh -i ${shellQuote(m.keyPath)} -o IdentitiesOnly=yes -o BatchMode=yes ${m.user}@${m.host} "<คำสั่ง>"`,
    `shell ฝั่งโน้น = ${m.shell}. ใช้ path แบบเต็ม, ห้ามคำสั่งที่ลบ/ติดตั้ง/รีสตาร์ทโดยไม่ถามผู้ใช้ก่อน. ถ้ายังไม่ได้รับคำสั่งงาน ให้ตอบสั้นๆ ว่ารับทราบ.`,
  ];
  if (m.notes) lines.push(`หมายเหตุเครื่อง: ${m.notes}`);
  return lines.join('\n');
}

export function detachMessage(name: string): string {
  return `[ยกเลิกเชื่อมเครื่อง ${name}] ไม่ต้องใช้เครื่องนี้แล้ว`;
}

// ---------- service ----------

export interface MachineRunner {
  isAlive(sessionId: string): boolean;
  send(sessionId: string, text: string): void;
}

export interface MachineDeps {
  db: WorklogDb;
  runner?: MachineRunner;
  now?: () => number;
  sshDir?: string; // default ~/.ssh
  connect?: ConnectFn;
  execFile?: ExecFileFn;
  newId?: () => string;
  log?: (entry: Record<string, unknown>) => void;
}

interface Status {
  reach: MachineInfo['reach'];
  lastCheck: number | null;
  tested?: 'ok' | 'fail';
  sshError?: string;
}

export class MachineService extends EventEmitter {
  private readonly deps: MachineDeps;
  private readonly now: () => number;
  private readonly sshDir: string;
  private readonly connect: ConnectFn;
  private readonly execFile: ExecFileFn;
  private readonly status = new Map<string, Status>();
  private readonly agentStatus = new Map<string, { state: AgentState; error?: string; cwds?: string[] }>();
  private readonly attach = new Map<string, MachineAttachment>(); // key sessionId|machineId
  private peers: TailscalePeer[] = [];
  private probeTimer: NodeJS.Timeout | null = null;
  private peerTimer: NodeJS.Timeout | null = null;
  private lastSent = '';

  constructor(deps: MachineDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sshDir = path.resolve(deps.sshDir ?? path.join(os.homedir(), '.ssh'));
    this.connect = deps.connect ?? defaultConnect;
    this.execFile = deps.execFile ?? defaultExecFile;
    this.seedOnce();
  }

  /** Default machines go in once: only when the table is empty and was never seeded before. */
  private seedOnce(): void {
    const db = this.deps.db;
    if (db.machinesSeeded()) return;
    if (db.countMachines() === 0) {
      const t = this.now();
      SEED_MACHINES.forEach((m, i) => db.insertMachine({ ...m, created: t + i }));
    }
    db.markMachinesSeeded();
  }

  // ----- validation -----

  /** Full validation of a form: shape + the key file (must exist under ~/.ssh). Returns the cleaned fields. */
  validate(f: MachineFields): Omit<MachineRow, 'id' | 'created'> {
    const err = checkMachineShape(f);
    if (err) throw new CommandError(err);
    let keyPath = '';
    if (f.keyPath.trim() !== '') {
      keyPath = this.resolveKey(f.keyPath.trim());
      let ok = false;
      try {
        ok = fs.statSync(keyPath).isFile(); // existence only; the key is never read
      } catch {
        ok = false;
      }
      if (!ok) throw new CommandError('ไม่พบไฟล์ key ใน ~/.ssh');
    }
    return { name: oneLine(f.name), host: f.host, user: f.user, keyPath, shell: f.shell, notes: oneLine(f.notes ?? ''), agent: f.agent === true };
  }

  /** Expands ~ and refuses anything outside ~/.ssh (also through symlinks). Does not read the file. */
  private resolveKey(raw: string): string {
    const abs = path.resolve(resolveTilde(raw));
    if (!this.insideSsh(abs)) throw new CommandError('key ต้องอยู่ในโฟลเดอร์ ~/.ssh เท่านั้น');
    try {
      const real = fs.realpathSync(abs);
      const root = fs.realpathSync(this.sshDir);
      const rel = path.relative(root.toLowerCase(), real.toLowerCase());
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new CommandError('key ต้องอยู่ในโฟลเดอร์ ~/.ssh เท่านั้น');
    } catch (e) {
      if (e instanceof CommandError) throw e;
      // file missing: the existence check reports it
    }
    return abs;
  }

  private insideSsh(abs: string): boolean {
    const rel = path.relative(this.sshDir.toLowerCase(), path.resolve(abs).toLowerCase());
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  // ----- CRUD -----

  add(f: MachineFields): string {
    const clean = this.validate(f);
    const id = this.deps.newId?.() ?? `m_${randomBytes(4).toString('hex')}`;
    this.deps.db.insertMachine({ id, ...clean, created: this.now() });
    this.changed();
    return id;
  }

  update(id: string, f: MachineFields): string {
    const cur = this.deps.db.getMachine(id);
    if (!cur) throw new CommandError('ไม่พบเครื่องนี้');
    const clean = this.validate(f);
    if (f.agent === undefined) clean.agent = cur.agent === true; // an older form that does not know the toggle keeps it
    this.deps.db.updateMachine({ id, ...clean });
    const st = this.status.get(id);
    if (st) {
      delete st.tested; // connection details changed: the old test result no longer counts
      delete st.sshError;
    }
    this.changed();
    return id;
  }

  /** Removes the machine and every attachment to it. */
  remove(id: string): string {
    if (!this.deps.db.deleteMachine(id)) throw new CommandError('ไม่พบเครื่องนี้');
    for (const [k, a] of [...this.attach]) if (a.machineId === id) this.attach.delete(k);
    this.status.delete(id);
    this.agentStatus.delete(id);
    this.changed();
    return id;
  }

  // ----- views -----

  private info(r: MachineRow): MachineInfo {
    const st = this.status.get(r.id);
    const configured = r.user !== '' && r.keyPath !== '';
    const ssh: MachineInfo['ssh'] = !configured ? 'not_configured' : (st?.tested ?? 'untested');
    const out: MachineInfo = {
      id: r.id,
      name: r.name,
      host: r.host,
      user: r.user,
      keyPath: r.keyPath,
      shell: r.shell as MachineShell,
      notes: r.notes,
      reach: st?.reach ?? 'unknown',
      ssh,
      lastCheck: st?.lastCheck ?? null,
    };
    if (ssh === 'fail' && st?.sshError) out.sshError = st.sshError;
    if (r.agent) {
      const ag = this.agentStatus.get(r.id);
      out.agent = true;
      out.agentState = ag?.state ?? 'connecting';
      if (ag?.state === 'error' && ag.error) out.agentError = ag.error;
      if (ag?.cwds && ag.cwds.length > 0) out.agentCwds = ag.cwds;
    }
    return out;
  }

  /** The remote hub reports each agent machine's connection here; it shows on the machine node. */
  setAgentStatus(id: string, st: { state: AgentState; error?: string; cwds?: string[] } | null): void {
    if (st === null) this.agentStatus.delete(id);
    else this.agentStatus.set(id, st);
    this.changed();
  }

  list(): MachineInfo[] {
    return this.deps.db.listMachines().map((r) => this.info(r));
  }

  attachments(): MachineAttachment[] {
    return [...this.attach.values()].sort((a, b) => a.at - b.at);
  }

  tailscalePeers(): TailscalePeer[] {
    return this.peers;
  }

  /** The whole payload of the `machines` message. */
  view(): { machines: MachineInfo[]; attachments: MachineAttachment[]; peers: TailscalePeer[] } {
    return { machines: this.list(), attachments: this.attachments(), peers: this.peers };
  }

  private changed(): void {
    const json = JSON.stringify(this.view());
    if (json === this.lastSent) return;
    this.lastSent = json;
    this.emit('change', this.view());
  }

  // ----- reachability + peers -----

  /** One TCP probe round over every machine. */
  async probe(): Promise<void> {
    const rows = this.deps.db.listMachines();
    const results = await Promise.all(
      rows.map(async (r) => {
        let ok = false;
        try {
          ok = await this.connect(r.host, 22, PROBE_TIMEOUT_MS);
        } catch {
          ok = false;
        }
        return [r.id, ok] as const;
      }),
    );
    const t = this.now();
    for (const [id, ok] of results) {
      if (!this.deps.db.getMachine(id)) continue; // deleted while probing
      const st = this.status.get(id) ?? { reach: 'unknown' as const, lastCheck: null };
      st.reach = ok ? 'online' : 'offline';
      st.lastCheck = t;
      this.status.set(id, st);
    }
    this.changed();
  }

  /** `tailscale status --json` (execFile, no shell). Missing tailscale gives []. */
  async refreshPeers(): Promise<void> {
    const tryRun = async (bin: string): Promise<string | null> => {
      try {
        const r = await this.execFile(bin, ['status', '--json'], { timeout: 5000 });
        return r.stdout;
      } catch {
        return null;
      }
    };
    let out = await tryRun('tailscale');
    if (out === null && process.platform === 'win32') out = await tryRun('C:\\Program Files\\Tailscale\\tailscale.exe');
    this.peers = out === null ? [] : parseTailscalePeers(out);
    this.changed();
  }

  start(): void {
    if (this.probeTimer) return;
    void this.probe();
    void this.refreshPeers();
    this.probeTimer = setInterval(() => void this.probe(), PROBE_MS);
    this.peerTimer = setInterval(() => void this.refreshPeers(), PEERS_MS);
    this.probeTimer.unref?.();
    this.peerTimer.unref?.();
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.peerTimer) clearInterval(this.peerTimer);
    this.probeTimer = null;
    this.peerTimer = null;
  }

  // ----- ssh test -----

  private configured(r: MachineRow): void {
    if (r.user === '' || r.keyPath === '') throw new CommandError('เครื่องนี้ยังไม่ได้ตั้งค่า SSH');
    if (!this.insideSsh(r.keyPath)) throw new CommandError('key ต้องอยู่ในโฟลเดอร์ ~/.ssh เท่านั้น');
  }

  /** Runs `ssh ... echo cr-ok` once. Records ok / fail (first stderr line, clipped 200). */
  async test(id: string): Promise<void> {
    const r = this.deps.db.getMachine(id);
    if (!r) throw new CommandError('ไม่พบเครื่องนี้');
    this.configured(r);
    const args = [
      '-i', r.keyPath,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${r.user}@${r.host}`,
      'echo cr-ok',
    ];
    let stdout = '';
    let stderr = '';
    try {
      const res = await this.execFile('ssh', args, { timeout: TEST_TIMEOUT_MS });
      stdout = res.stdout;
      stderr = res.stderr;
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string; message?: string };
      stdout = x.stdout ?? '';
      stderr = x.stderr || x.message || 'ssh failed';
    }
    const st = this.status.get(id) ?? { reach: 'unknown' as const, lastCheck: null };
    if (stdout.includes('cr-ok')) {
      st.tested = 'ok';
      delete st.sshError;
    } else {
      const first = stderr.split(/\r?\n/).find((l) => l.trim() !== '') ?? 'ssh failed';
      st.tested = 'fail';
      st.sshError = first.trim().slice(0, 200);
    }
    this.status.set(id, st);
    this.changed();
  }

  // ----- attach / detach -----

  private key(sessionId: string, machineId: string): string {
    return `${sessionId}|${machineId}`;
  }

  /** Tells a live Runner job about a machine, once per (job, machine). */
  attachJob(sessionId: string, machineId: string): void {
    const runner = this.deps.runner;
    if (!runner || !runner.isAlive(sessionId)) throw new CommandError('ต่อเครื่องได้เฉพาะงานที่คุมจากเว็บ');
    const m = this.deps.db.getMachine(machineId);
    if (!m) throw new CommandError('ไม่พบเครื่องนี้');
    this.configured(m);
    if (this.attach.has(this.key(sessionId, machineId))) return; // idempotent
    runner.send(sessionId, attachMessage(m));
    this.attach.set(this.key(sessionId, machineId), { sessionId, machineId, at: this.now() });
    this.changed();
  }

  detachJob(sessionId: string, machineId: string): void {
    const had = this.attach.delete(this.key(sessionId, machineId));
    const m = this.deps.db.getMachine(machineId);
    if (had && m && this.deps.runner?.isAlive(sessionId)) {
      try {
        this.deps.runner.send(sessionId, detachMessage(m.name));
      } catch {
        // the job ended between the check and the send: nothing to tell
      }
    }
    if (had) this.changed();
  }

  /** The session left the Runner / watcher: forget its attachments. */
  onSessionGone(sessionId: string): void {
    let any = false;
    for (const [k, a] of [...this.attach]) {
      if (a.sessionId === sessionId) {
        this.attach.delete(k);
        any = true;
      }
    }
    if (any) this.changed();
  }
}
