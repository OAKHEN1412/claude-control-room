// "+ เครื่อง" form: fields, validation (mirrors the server's rules for host / user / key path) and the message it sends.
import type { MachineInfo, MachineShell, TailscalePeer } from './protocolNext';
import { t } from './i18n';
import { serverCode } from './i18n/serverMsg';

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

export const keyHint = (): string => t('machine.helper.keyHint');

/** Key path: empty (not configured yet) or a file directly under a .ssh folder: `~/.ssh/x`, or `C:/Users/you/.ssh/x`. */
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
  if (name === '') e.name = t('machine.helper.nameEmpty');
  else if (name.length > NAME_MAX) e.name = t('machine.helper.nameTooLong', { max: NAME_MAX });
  const host = f.host.trim();
  if (host === '') e.host = t('machine.helper.hostEmpty');
  else if (!HOST_RE.test(host)) e.host = t('machine.helper.hostInvalid');
  const user = f.user.trim();
  if (user === '') e.user = t('machine.helper.userEmpty');
  else if (!USER_RE.test(user)) e.user = t('machine.helper.userInvalid');
  if (!validKeyPath(f.keyPath)) e.keyPath = t('machine.helper.keyPathInvalid');
  if (f.notes.length > NOTES_MAX) e.notes = t('machine.helper.notesTooLong', { max: NOTES_MAX });
  return e;
}

export const isValidMachine = (f: MachineForm): boolean => Object.keys(validateMachine(f)).length === 0;

/** Choosing a Tailscale peer prefills name and host (the rest of the form is kept). */
export function applyPeer(f: MachineForm, peer: Pick<TailscalePeer, 'name' | 'ip'>): MachineForm {
  return { ...f, name: peer.name, host: peer.ip };
}

/** The server returns an absolute key path (`C:\Users\you\.ssh\id_ed25519`); the UI shows `~/.ssh/id_ed25519`. */
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

// Getters: each access resolves the text in the current language, so nothing is translated at module load.
export const REACH_WORD: Record<MachineInfo['reach'], string> = {
  get online() { return t('machine.helper.reachOnline'); },
  get offline() { return t('machine.helper.reachOffline'); },
  get unknown() { return t('machine.helper.reachUnknown'); },
};
export const AGENT_WORD: Record<NonNullable<MachineInfo['agentState']>, string> = {
  get connecting() { return t('machine.helper.agentConnecting'); },
  get online() { return t('machine.helper.agentOnline'); },
  get error() { return t('machine.helper.agentError'); },
};

/** One line for the machine node: the agent's state, or '' when the machine does not run one. */
export function agentLine(m: Pick<MachineInfo, 'agent' | 'agentState' | 'agentError' | 'agentCode' | 'agentVars'>): string {
  if (!m.agent) return '';
  const st = m.agentState ?? 'connecting';
  if (st !== 'error' || !m.agentError) return AGENT_WORD[st];
  // The server sends the error as a code + vars; the Thai agentError is the fallback when the code is unknown.
  return t('machine.helper.agentErrorLine', { error: serverCode(m.agentCode, m.agentVars, m.agentError) });
}

export const SSH_WORD: Record<MachineInfo['ssh'], string> = {
  get ok() { return t('machine.helper.sshOk'); },
  get fail() { return t('machine.helper.sshFail'); },
  get untested() { return t('machine.helper.sshUntested'); },
  get not_configured() { return t('machine.helper.sshNotConfigured'); },
};
