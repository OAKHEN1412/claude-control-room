// Account profiles: the shared (pure) part used by the server and the web UI. No I/O, no Node imports.
// A profile is a named Claude login; a job runs as one of them by getting its OAuth token in the child env.

/** Built-in "Terminal login" profile: no token, uses the stored login of the terminal claude. */
export const TERMINAL_ACCOUNT_ID = 'terminal';
export const RESERVED_ACCOUNT_IDS: readonly string[] = ['terminal', 'default', 'main'];
export const ACCOUNT_ID_RE = /^[a-z0-9-]{1,64}$/;
export const ACCOUNT_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#6366f1', '#ec4899'] as const;
export const ACCOUNT_NAME_MAX = 40;
export const ACCOUNT_NOTE_MAX = 80;
export const ACCOUNT_LETTER_MAX = 2;
export const TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{60,200}$/;
export const TOKEN_LIFETIME_MS = 365 * 24 * 3600_000; // approx
export const EXPIRY_WARN_MS = 30 * 24 * 3600_000;

export interface AccountUsageWindow { pct: number; resetsAt: number | null } // pct 0..100, resetsAt epoch ms
export interface AccountUsage { fiveHour: AccountUsageWindow | null; sevenDay: AccountUsageWindow | null; updatedAt: number }

/** Login state of the built-in main account (the terminal claude's own login). Email is the only personal field. */
export interface MainAccountInfo {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  orgName: string | null;
  expiresAt: number | null;
  checkedAt: number;
}

export type MainLoginStatus = 'starting' | 'waiting_browser' | 'success' | 'failed' | 'timeout' | 'cancelled';
/** url only on waiting_browser: https, host claude.ai / claude.com / anthropic.com or a subdomain. error: a CODE, never raw text. */
export interface MainLoginEvent { status: MainLoginStatus; url?: string; needCode?: boolean; error?: string }

export interface AccountInfo {
  id: string; name: string;
  color: string; // one of ACCOUNT_COLORS
  letter: string; // 1-2 chars shown in the avatar
  note: string; // '' when none
  builtin: boolean; // true only for the Terminal login profile
  tokenState: 'set' | 'unset'; // builtin is always 'unset' (it has no token)
  fingerprint: string | null; // first 8 hex of sha256(token); null when no token
  createdAt: number; // epoch ms of the profile
  tokenAt: number | null; // epoch ms the current token was saved
  expiresAt: number | null; // tokenAt + TOKEN_LIFETIME_MS (approx); null when no token
  lastCheckAt: number | null; lastCheckOk: boolean | null;
  usage: AccountUsage | null;
  hidden: boolean; // hidden from the switcher
  locked: boolean; // token profile with a password, not unlocked in this server run
  hasPassword: boolean; // the token is stored encrypted with a password
  main?: MainAccountInfo; // only on the builtin terminal profile, when the main account status is known
}
export interface AccountsView { accounts: AccountInfo[]; defaultId: string; ptyAvailable: boolean } // builtin first, then by createdAt

export type ConnectStatus = 'waiting_browser' | 'captured' | 'checking' | 'done' | 'failed' | 'timeout' | 'cancelled';
export interface ConnectEvent { accountId: string; status: ConnectStatus; url?: string; error?: string; checkOk?: boolean }
// url only on waiting_browser: https only, host claude.ai / claude.com / anthropic.com or a subdomain. error: a CODE, never raw text.

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 128;
export const LOGIN_CODE_MAX = 512;

/** Password for a token profile or the app lock: a string of PASSWORD_MIN..PASSWORD_MAX code points. Not trimmed. */
export function validatePassword(p: unknown): boolean {
  if (typeof p !== 'string') return false;
  const n = [...p].length;
  return n >= PASSWORD_MIN && n <= PASSWORD_MAX;
}

/**
 * App lock PIN: exactly 6 ASCII digits. Error code for a wrong format: PIN_INVALID (400 on the HTTP API).
 * Profile passwords keep validatePassword; the PIN is only for the app lock.
 */
export const PIN_RE = /^[0-9]{6}$/;

/** True only for a string of exactly 6 ASCII digits. No trimming: a space or any other character is invalid. */
export function validatePin(p: unknown): p is string {
  return typeof p === 'string' && PIN_RE.test(p);
}

/** Pasted login code: trimmed, 1..LOGIN_CODE_MAX chars, no control characters. Returns the trimmed code, or null when invalid. */
export function validateLoginCode(c: unknown): string | null {
  if (typeof c !== 'string') return null;
  const t = c.trim();
  const n = [...t].length;
  if (n < 1 || n > LOGIN_CODE_MAX) return null;
  // C0 and C1 control characters (tab and newline included: a code is one token)
  if (/[\x00-\x1f\x7f-\x9f]/.test(t)) return null;
  return t;
}

/**
 * Masks an email for display: 'alice@example.com' -> 'a***@example.com'. No '@' -> first char + '***'.
 * null, undefined or '' -> ''.
 */
export function maskEmail(email: string | null | undefined): string {
  if (typeof email !== 'string' || email === '') return '';
  const at = email.indexOf('@');
  const first = [...email][0] ?? '';
  if (at < 0) return `${first}***`;
  const domain = email.slice(at);
  if (at === 0) return `***${domain}`;
  return `${first}***${domain}`;
}

/** 'abcd1234...' -> 'abcd·1234'. Null, empty or shorter than 8 chars -> ''. */
export function formatFingerprint(fp: string | null | undefined): string {
  if (typeof fp !== 'string' || fp.length < 8) return '';
  const s = fp.slice(0, 8);
  return `${s.slice(0, 4)}·${s.slice(4)}`;
}

/** Time left until the token expires, in ms. Negative = expired. Null when the profile has no token. */
export function expiryLeftMs(a: Pick<AccountInfo, 'expiresAt'>, now: number): number | null {
  return a.expiresAt === null ? null : a.expiresAt - now;
}

/** 'none' without a token, 'expired' when past, 'warn' when less than EXPIRY_WARN_MS is left, else 'ok'. */
export function expiryLevel(a: Pick<AccountInfo, 'expiresAt'>, now: number): 'ok' | 'warn' | 'expired' | 'none' {
  const left = expiryLeftMs(a, now);
  if (left === null) return 'none';
  if (left < 0) return 'expired';
  if (left < EXPIRY_WARN_MS) return 'warn';
  return 'ok';
}

type ProfileValue = { name?: string; color?: string; letter?: string; note?: string };
type ProfileResult = { ok: true; value: ProfileValue } | { ok: false; error: string };

/** Count of user-visible characters (code points), so Thai and emoji are counted once each. */
function charCount(s: string): number {
  return [...s].length;
}

/**
 * Validates a create / patch body. name is trimmed with inner whitespace collapsed (1..40 chars);
 * color must be one of ACCOUNT_COLORS; letter is trimmed, upper-cased, 1..2 chars; note is trimmed, <= 80 chars.
 * partial = true validates only the fields that are given. Unknown fields are ignored.
 */
export function validateProfileInput(input: unknown, partial: boolean): ProfileResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, error: 'BAD_REQUEST' };
  const r = input as Record<string, unknown>;
  const value: ProfileValue = {};

  if (r.name !== undefined || !partial) {
    if (typeof r.name !== 'string') return { ok: false, error: 'NAME_INVALID' };
    const name = r.name.trim().replace(/\s+/g, ' ');
    if (charCount(name) < 1 || charCount(name) > ACCOUNT_NAME_MAX) return { ok: false, error: 'NAME_INVALID' };
    value.name = name;
  }
  if (r.color !== undefined) {
    if (typeof r.color !== 'string' || !(ACCOUNT_COLORS as readonly string[]).includes(r.color)) return { ok: false, error: 'COLOR_INVALID' };
    value.color = r.color;
  }
  if (r.letter !== undefined) {
    if (typeof r.letter !== 'string') return { ok: false, error: 'LETTER_INVALID' };
    const letter = r.letter.trim().toUpperCase();
    const n = charCount(letter);
    if (n < 1 || n > ACCOUNT_LETTER_MAX) return { ok: false, error: 'LETTER_INVALID' };
    value.letter = letter;
  }
  if (r.note !== undefined) {
    if (typeof r.note !== 'string') return { ok: false, error: 'NOTE_INVALID' };
    const note = r.note.trim();
    if (charCount(note) > ACCOUNT_NOTE_MAX) return { ok: false, error: 'NOTE_INVALID' };
    value.note = note;
  }
  return { ok: true, value };
}

/**
 * Default avatar letter: the first letter or digit of the first one or two words, upper-cased.
 * 'hello world' -> 'HW', 'สมชาย' -> 'ส', '' -> '?'.
 */
export function defaultLetter(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '').slice(0, 2);
  const letters: string[] = [];
  for (const w of words) {
    const m = /[\p{L}\p{N}]/u.exec(w);
    if (m) letters.push(m[0]);
  }
  if (letters.length === 0) return '?';
  return letters.join('').toUpperCase();
}

/** True when the 5 h or 7 d window is at 99 % or more and its reset is still ahead (or unknown). */
export function isLimited(a: Pick<AccountInfo, 'usage'>, now: number): boolean {
  if (!a.usage) return false;
  return [a.usage.fiveHour, a.usage.sevenDay].some((w) => w !== null && w.pct >= 99 && (w.resetsAt === null || w.resetsAt > now));
}
