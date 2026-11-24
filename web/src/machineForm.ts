// "+ เครื่อง" form: fields, validation (mirrors the server's rules for host / user / key path) and the message it sends.
import type { MachineInfo, MachineShell, TailscalePeer } from './protocolNext';

export const SHELLS: readonly MachineShell[] = ['cmd', 'powershell', 'bash'];
export const NAME_MAX = 40;
export const NOTES_MAX = 300;

export interface MachineForm {
  name: string;
  host: string;
  user: string;
  keyPath: string;
  shell: MachineShell;
  notes: string;
  agent?: boolean; // "ดู Claude บนเครื่องนี้"
}

export const EMPTY_MACHINE_FORM: MachineForm = { name: '', host: '', user: '', keyPath: '', shell: 'cmd', notes: '', agent: false };

export type MachineFormErrors = Partial<Record<'name' | 'host' | 'user' | 'keyPath' | 'notes', string>>;

// host name or IPv4 address; never starts with "-" (it would be read as an ssh option)
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
const KEY_FILE_RE = /^[A-Za-z0-9._-]+$/;

export const KEY_HINT = '~/.ssh/ชื่อไฟล์คีย์ เช่น ~/.ssh/id_ed25519';

/** Key path: empty (not configured yet) or a file directly under a .ssh folder: `~/.ssh/x`, or `C:/Users/me/.ssh/x`. */
export function validKeyPath(raw: string): boolean {
  const p = raw.trim().replace(/\\/g, '/');
  if (p === '') return true;
  if (p.includes('..') || /[\s"'`;&|<>]/.test(p)) return false;
  const m = /^(?:~|\$HOME|[A-Za-z]:\/Users\/[^/]+|\/home\/[^/]+|\/Users\/[^/]+)\/\.ssh\/([^/]+)$/.exec(p);
  return !!m && KEY_FILE_RE.test(m[1]);
}

export function validateMachine(f: MachineForm): MachineFormErrors {
  const e: MachineFormErrors = {};
  const name = f.name.trim();
  if (name === '') e.name = 'ใส่ชื่อเครื่อง';
  else if (name.length > NAME_MAX) e.name = `ชื่อยาวเกิน ${NAME_MAX} ตัวอักษร`;
  const host = f.host.trim();
  if (host === '') e.host = 'ใส่ที่อยู่เครื่อง (ชื่อ Tailscale หรือ IP)';
  else if (!HOST_RE.test(host)) e.host = 'ที่อยู่ใช้ได้เฉพาะ a-z 0-9 . - และห้ามขึ้นต้นด้วย -';
  const user = f.user.trim();
  if (user === '') e.user = 'ใส่ชื่อผู้ใช้ SSH';
  else if (!USER_RE.test(user)) e.user = 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - และห้ามขึ้นต้นด้วย - หรือ .';
  if (!validKeyPath(f.keyPath)) e.keyPath = 'ไฟล์คีย์ต้องอยู่ในโฟลเดอร์ ~/.ssh/ (ห้ามมี .. หรือช่องว่าง)';
  if (f.notes.length > NOTES_MAX) e.notes = `บันทึกยาวเกิน ${NOTES_MAX} ตัวอักษร`;
  return e;
}

export const isValidMachine = (f: MachineForm): boolean => Object.keys(validateMachine(f)).length === 0;

/** Choosing a Tailscale peer prefills name and host (the rest of the form is kept). */
export function applyPeer(f: MachineForm, peer: Pick<TailscalePeer, 'name' | 'ip'>): MachineForm {
  return { ...f, name: peer.name, host: peer.ip };
}

/** The server returns an absolute key path (`C:\Users\x\.ssh\id_ed25519`); the UI shows `~/.ssh/id_ed25519`. */
export function shortKeyPath(p: string): string {
  const t = p.trim().replace(/\\/g, '/');
  const i = t.lastIndexOf('/.ssh/');
  return i >= 0 ? `~/.ssh/${t.slice(i + 6)}` : t;
}

export function formFromMachine(m: MachineInfo): MachineForm {
  return { name: m.name, host: m.host, user: m.user, keyPath: shortKeyPath(m.keyPath), shell: m.shell, notes: m.notes, agent: m.agent === true };
}

/** Trimmed fields of a valid form, ready for machine_add / machine_update. */
export function formPayload(f: MachineForm): { name: string; host: string; user: string; keyPath: string; shell: MachineShell; notes?: string; agent?: boolean } {
  const notes = f.notes.trim();
  return {
    name: f.name.trim(),
    host: f.host.trim(),
    user: f.user.trim(),
    keyPath: f.keyPath.trim(),
    shell: f.shell,
    ...(notes ? { notes } : {}),
    ...(f.agent !== undefined ? { agent: f.agent } : {}),
  };
}

// ---- status words ----

export const REACH_WORD: Record<MachineInfo['reach'], string> = { online: 'ออนไลน์', offline: 'ออฟไลน์', unknown: 'ยังไม่ทราบ' };
export const AGENT_WORD: Record<NonNullable<MachineInfo['agentState']>, string> = { connecting: 'กำลังเชื่อมต่อ…', online: 'ดู Claude ได้', error: 'เชื่อมต่อไม่ได้' };

/** One line for the machine node: the agent's state, or '' when the machine does not run one. */
export function agentLine(m: Pick<MachineInfo, 'agent' | 'agentState' | 'agentError'>): string {
  if (!m.agent) return '';
  const st = m.agentState ?? 'connecting';
  return st === 'error' && m.agentError ? `${AGENT_WORD.error}: ${m.agentError}` : AGENT_WORD[st];
}

export const SSH_WORD: Record<MachineInfo['ssh'], string> = { ok: 'SSH ใช้ได้', fail: 'SSH ไม่ผ่าน', untested: 'ยังไม่ทดสอบ', not_configured: 'ยังไม่ตั้งค่า' };
