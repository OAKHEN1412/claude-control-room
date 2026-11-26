// Pure helpers for the account (profile) UI: avatars, switcher order, usage badges, expiry text, connect state.
// No React, no I/O. Shapes come from shared/accounts.ts; messages from shared/protocol.ts.
import {
  ACCOUNT_COLORS,
  TERMINAL_ACCOUNT_ID,
  expiryLeftMs,
  expiryLevel,
  isLimited,
  maskEmail,
  type AccountInfo,
  type AccountUsage,
  type AccountUsageWindow,
  type ConnectEvent,
} from '../../shared/accounts';
import type { ServerMsg } from '../../shared/protocol';
import type { UsageQuota, UsageSnapshot } from '../../shared/usage';
import type { ServerMsgNext } from './protocolNext';
import { getLanguage, tx } from './i18n';

const DAY_MS = 24 * 3600_000;

/** Input for the avatar letter: any profile, with builtin/main optional so older callers still compile. */
export type AvatarLetterInput = Pick<AccountInfo, 'letter'> & Partial<Pick<AccountInfo, 'builtin' | 'main'>>;

/**
 * The letter an avatar shows. Token profiles keep their stored letter. The built-in main account shows the first
 * letter or digit of its email's local part (upper-cased); with no email it shows 'ห' in Thai and 'M' in English.
 */
export function displayLetter(a: AvatarLetterInput): string {
  if (!a.builtin) return a.letter || '?';
  const email = a.main?.email ?? '';
  const local = email.includes('@') ? email.slice(0, email.indexOf('@')) : email;
  const ch = [...local].find((c) => /[\p{L}\p{N}]/u.test(c));
  if (ch) return ch.toUpperCase();
  return getLanguage() === 'en' ? 'M' : 'ห';
}

/** Avatar letter and colour. Falls back to the first palette colour when the stored one is unknown. */
export function avatarOf(a: AccountInfo): { letter: string; color: string } {
  const color = (ACCOUNT_COLORS as readonly string[]).includes(a.color) ? a.color : ACCOUNT_COLORS[0];
  return { letter: displayLetter(a), color };
}

/** Profiles shown in the switcher: hidden ones are left out, the default comes first, the rest keep server order. */
export function visibleProfiles(accounts: AccountInfo[], defaultId: string): AccountInfo[] {
  const shown = accounts.filter((a) => !a.hidden);
  const def = shown.filter((a) => a.id === defaultId);
  return [...def, ...shown.filter((a) => a.id !== defaultId)];
}

export function profileById(accounts: AccountInfo[], id: string): AccountInfo | undefined {
  return accounts.find((a) => a.id === id);
}

/**
 * A profile's usage as AccountUsage, the one shape every list, badge and bar reads.
 * - Built-in main account and Terminal login: the global snapshot (the one the header rings show), mapped
 *   back from UsageQuota to AccountUsageWindow. No quota in the snapshot -> null.
 * - Token profiles: their own account.usage.
 * `global` is the server's usage snapshot (AccountsCtx.usage); without it the built-in profile has no usage.
 */
export function usageOfProfile(a: AccountInfo, global?: UsageSnapshot): AccountUsage | null {
  if (!(a.builtin || a.id === TERMINAL_ACCOUNT_ID)) return a.usage ?? null;
  if (!global || (!global.fiveHour && !global.sevenDay)) return null;
  const win = (q: UsageQuota | null): AccountUsageWindow | null => (q ? { pct: q.pct, resetsAt: q.resetsAt } : null);
  return {
    fiveHour: win(global.fiveHour),
    sevenDay: win(global.sevenDay),
    updatedAt: Math.max(global.fiveHour?.updatedAt ?? 0, global.sevenDay?.updatedAt ?? 0),
  };
}

/** The profile as the limit and badge helpers should see it: its `usage` replaced by usageOfProfile(a, global). */
export function withUsage(a: AccountInfo, global?: UsageSnapshot): AccountInfo {
  return { ...a, usage: usageOfProfile(a, global) };
}

export type UsageBadge = { kind: 'limit' } | { kind: 'week'; pct: number } | { kind: 'none' };

/** 'limit' when a window is at the cap, else the weekly percentage when known, else nothing. */
export function badgeOf(a: AccountInfo, now: number, global?: UsageSnapshot): UsageBadge {
  const b = withUsage(a, global);
  if (isLimited(b, now)) return { kind: 'limit' };
  const seven = b.usage?.sevenDay;
  if (seven) return { kind: 'week', pct: Math.round(seven.pct) };
  return { kind: 'none' };
}

/** 5 h and 7 d percentages, rounded; null where the window is unknown. */
export function weekAndFiveHour(a: AccountInfo, global?: UsageSnapshot): { five: number | null; seven: number | null } {
  const u = usageOfProfile(a, global);
  return {
    five: u?.fiveHour ? Math.round(u.fiveHour.pct) : null,
    seven: u?.sevenDay ? Math.round(u.sevenDay.pct) : null,
  };
}

/**
 * Expiry level plus whole days left (rounded up, so 2 hours left reads as 1 day).
 * days is null when there is no token or the token already expired.
 */
export function describeExpiry(a: AccountInfo, now: number): { level: 'ok' | 'warn' | 'expired' | 'none'; days: number | null } {
  const level = expiryLevel(a, now);
  const left = expiryLeftMs(a, now);
  if (left === null || left < 0) return { level, days: null };
  return { level, days: Math.ceil(left / DAY_MS) };
}

/** A profile a job can run as now: not locked by the password, and either the built-in login or a token is set. */
export function isUsable(a: AccountInfo): boolean {
  return !a.locked && (a.builtin || a.tokenState === 'set');
}

/** A token profile whose token is still sealed by a password: it needs the unlock dialog before use. */
export function needsUnlock(a: AccountInfo): boolean {
  return a.locked;
}

/** Name shown for a profile: the built-in profile is always called by its translated name, others by their own name. */
export function displayName(a: AccountInfo, t: (key: string) => string): string {
  return a.builtin ? t('acct.terminal.name') : a.name;
}

/** The main account's email, masked for display (a***@domain). Empty when the profile has no main info or no email. */
export function maskedEmail(a: AccountInfo): string {
  return maskEmail(a.main?.email ?? null);
}

/** True once the connect flow has nothing more to report. */
export function connectIsFinal(e: ConnectEvent): boolean {
  return e.status === 'done' || e.status === 'failed' || e.status === 'timeout' || e.status === 'cancelled';
}

/** Account slice of the server state (mirrors the fields in useServer's ServerState). */
export interface AccountsSlice {
  accounts: AccountInfo[];
  defaultAccountId: string;
  ptyAvailable: boolean;
  connect: ConnectEvent | null;
}

/**
 * Applies one server message to the account slice. Handles snapshot (only the fields it carries),
 * accounts (replaces the list, default and pty flag) and account_connect (stores the event).
 * Any other message returns the same state object.
 */
export function reduceAccounts(state: AccountsSlice, msg: ServerMsg | ServerMsgNext): AccountsSlice {
  // Returns only the four account fields, so the caller can spread the result into a larger state safely.
  const own = (s: AccountsSlice): AccountsSlice => ({
    accounts: s.accounts,
    defaultAccountId: s.defaultAccountId,
    ptyAvailable: s.ptyAvailable,
    connect: s.connect,
  });
  switch (msg.type) {
    case 'snapshot':
      return {
        ...own(state),
        accounts: Array.isArray(msg.accounts) ? msg.accounts : state.accounts,
        defaultAccountId: typeof msg.defaultAccountId === 'string' ? msg.defaultAccountId : state.defaultAccountId,
        ptyAvailable: typeof msg.ptyAvailable === 'boolean' ? msg.ptyAvailable : state.ptyAvailable,
      };
    case 'accounts':
      return {
        ...own(state),
        accounts: Array.isArray(msg.accounts) ? msg.accounts : state.accounts,
        defaultAccountId: typeof msg.defaultId === 'string' ? msg.defaultId : state.defaultAccountId,
        ptyAvailable: typeof msg.ptyAvailable === 'boolean' ? msg.ptyAvailable : state.ptyAvailable,
      };
    case 'account_connect':
      return { ...own(state), connect: msg.event && typeof msg.event === 'object' ? msg.event : state.connect };
    default:
      return own(state);
  }
}

/**
 * Whether the header should ask the server to refresh a profile's usage: a real profile with a token that has not
 * been asked for yet (lastRequestedId is the last profile asked for). Terminal, built-in and token-less profiles never.
 */
export function shouldRefresh(profile: AccountInfo | null | undefined, lastRequestedId: string | null): boolean {
  if (!profile || profile.builtin || profile.id === TERMINAL_ACCOUNT_ID) return false;
  if (profile.tokenState === 'unset') return false;
  return profile.id !== lastRequestedId;
}

const MISSING = '\u0000missing';
const CODE_SHAPE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Human text for an API / ws error code, or for a message the caller already translated.
 * - known code (acct.err.<code> exists): that text.
 * - code-shaped or srv.* input with no entry: the generic server error text.
 * - any other non-empty string (already a message): returned unchanged.
 */
export function errText(code: string): string {
  const known = tx(`acct.err.${code}`, undefined, MISSING);
  if (known !== MISSING) return known;
  const generic = tx('acct.err.SERVER_ERROR');
  if (code === '' || CODE_SHAPE.test(code) || code.startsWith('srv.')) return generic;
  return code;
}
