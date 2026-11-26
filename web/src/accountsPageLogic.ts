// Pure state and view-model helpers for the /accounts manage page. No React, no I/O.
// Shapes come from shared/accounts.ts; relative time reuses formatAge from shared/usage.ts.
import { expiryLeftMs, expiryLevel, formatFingerprint, validateProfileInput, type AccountInfo } from '../../shared/accounts';
import { formatAge, type UsageSnapshot } from '../../shared/usage';
import { describeExpiry, weekAndFiveHour } from './accountsView';
import { getLanguage } from './i18n';

/** How long a first delete click stays armed before it reverts on its own. */
export const DELETE_ARM_MS = 6000;

export type ExpiryLevel = 'ok' | 'warn' | 'expired' | 'none';
export type CheckState = 'ok' | 'fail' | 'never';

export interface ManageRow {
  id: string;
  name: string;
  color: string;
  letter: string;
  note: string;
  builtin: boolean;
  /** Built-in main account login info (email letter on the avatar). */
  main?: AccountInfo['main'];
  hidden: boolean;
  isDefault: boolean;
  /** tokenState is 'set'. The built-in Terminal row is never 'set'. */
  tokenSet: boolean;
  /** A real profile with no token yet: shows the prominent "not connected" state. */
  needsConnect: boolean;
  /** formatFingerprint result, or '—' when there is no token. */
  fingerprint: string;
  createdAt: number;
  expiry: { level: ExpiryLevel; days: number | null };
  /** CSS modifier class for the expiry text ('ap-exp-warn' etc.). */
  expiryClass: string;
  /** i18n key for the expiry text, or null when there is no token. */
  expiryKey: string | null;
  expiryVars: { days: number } | undefined;
  check: CheckState;
  checkAt: number | null;
  /** Rounded percentages, null when unknown. */
  fivePct: number | null;
  weekPct: number | null;
  fiveBar: number;
  weekBar: number;
}

/** Builtin first, then by createdAt (oldest first); id breaks ties so the order is stable. */
export function sortAccounts(accounts: AccountInfo[]): AccountInfo[] {
  return [...accounts].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Clamps a usage percentage to a 0..100 bar width. null, NaN and non-numbers read as 0. */
export function barWidth(pct: number | null | undefined): number {
  if (typeof pct !== 'number' || Number.isNaN(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/** CSS class for an expiry level. 'ok' and 'none' get the muted default. */
export function expiryClass(level: ExpiryLevel): string {
  switch (level) {
    case 'warn':
      return 'ap-exp-warn';
    case 'expired':
      return 'ap-exp-expired';
    default:
      return 'ap-exp-none';
  }
}

/** Manage-page rows. `usage` is the global snapshot: the built-in main account's bars come from it. */
export function buildRows(accounts: AccountInfo[], defaultId: string, now: number, usage?: UsageSnapshot): ManageRow[] {
  return sortAccounts(accounts).map((a) => {
    const tokenSet = a.tokenState === 'set';
    const expiry = describeExpiry(a, now);
    const bars = weekAndFiveHour(a, usage);
    const check: CheckState = a.lastCheckOk === true ? 'ok' : a.lastCheckOk === false ? 'fail' : 'never';
    return {
      id: a.id,
      name: a.name,
      color: a.color,
      letter: a.letter,
      note: a.note,
      builtin: a.builtin,
      main: a.main,
      hidden: a.hidden,
      isDefault: a.id === defaultId,
      tokenSet,
      needsConnect: !a.builtin && !tokenSet,
      fingerprint: tokenSet ? formatFingerprint(a.fingerprint) || '—' : '—',
      createdAt: a.createdAt,
      expiry,
      expiryClass: expiryClass(expiry.level),
      expiryKey: tokenSet ? `acct.expiry.${expiry.level}` : null,
      expiryVars: expiry.days === null ? undefined : { days: expiry.days },
      check,
      checkAt: a.lastCheckAt,
      fivePct: bars.five,
      weekPct: bars.seven,
      fiveBar: barWidth(bars.five),
      weekBar: barWidth(bars.seven),
    };
  });
}

/**
 * Relative time for "last check". Thai reuses formatAge from shared/usage.ts; English is written here
 * because formatAge only has Thai text.
 */
export function relTimeText(ts: number, now: number, lang: 'th' | 'en'): string {
  if (lang === 'th') return formatAge(ts, now);
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s} sec ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Validates a rename. Returns the trimmed name, or the error code (NAME_INVALID). */
export function checkName(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const r = validateProfileInput({ name: raw }, true);
  if (!r.ok) return r;
  return { ok: true, value: r.value.name ?? '' };
}

/** Validates a note edit (max 80 after trim). Empty is allowed and clears the note. */
export function checkNote(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const r = validateProfileInput({ note: raw }, true);
  if (!r.ok) return r;
  return { ok: true, value: r.value.note ?? '' };
}

// ---- two-click delete ----

export type DeleteState = { phase: 'idle' } | { phase: 'armed'; id: string; since: number } | { phase: 'deleted'; id: string };
export type DeleteEvent =
  | { type: 'press'; id: string; now: number }
  | { type: 'cancel' }
  | { type: 'tick'; now: number }
  | { type: 'reset' };

export const DELETE_IDLE: DeleteState = { phase: 'idle' };

/**
 * idle -> armed (first press) -> deleted (second press on the same row, action 'confirm').
 * A press on another row arms that row instead (disarming the first). cancel (Esc/blur) and tick
 * after DELETE_ARM_MS return an armed row to idle. reset returns to idle after the delete call ends.
 */
export function deleteReducer(s: DeleteState, e: DeleteEvent): { state: DeleteState; action: 'none' | 'arm' | 'confirm' } {
  switch (e.type) {
    case 'press':
      if (s.phase === 'armed' && s.id === e.id) return { state: { phase: 'deleted', id: e.id }, action: 'confirm' };
      if (s.phase === 'deleted') return { state: s, action: 'none' };
      return { state: { phase: 'armed', id: e.id, since: e.now }, action: 'arm' };
    case 'cancel':
      return s.phase === 'armed' ? { state: DELETE_IDLE, action: 'none' } : { state: s, action: 'none' };
    case 'tick':
      if (s.phase === 'armed' && e.now - s.since >= DELETE_ARM_MS) return { state: DELETE_IDLE, action: 'none' };
      return { state: s, action: 'none' };
    case 'reset':
      return { state: DELETE_IDLE, action: 'none' };
  }
}

/** True while the given row is the armed one and its window has not run out. */
export function isArmed(s: DeleteState, id: string, now: number): boolean {
  return s.phase === 'armed' && s.id === id && now - s.since < DELETE_ARM_MS;
}

// ---- main account: two-click "change main account" ----

/** How long the first click of "change main account" stays armed. */
export const MAIN_ARM_MS = 6000;

export type ArmState = { armed: false } | { armed: true; since: number };
export const ARM_IDLE: ArmState = { armed: false };

/** idle -> armed (first press, action 'arm') -> confirmed (second press, action 'confirm', back to idle). */
export function armPress(s: ArmState, now: number): { state: ArmState; action: 'arm' | 'confirm' } {
  if (s.armed) return { state: ARM_IDLE, action: 'confirm' };
  return { state: { armed: true, since: now }, action: 'arm' };
}

/** Returns idle once the armed window has run out (or on Esc / blur the caller passes disarm). */
export function armExpire(s: ArmState, now: number): ArmState {
  if (s.armed && now - s.since >= MAIN_ARM_MS) return ARM_IDLE;
  return s;
}

/** Expiry of the main account's login from its expiresAt (ms, or null when unknown). Same levels as token profiles. */
export function mainExpiry(expiresAt: number | null, now: number): { level: ExpiryLevel; days: number | null; cls: string; key: string | null; vars: { days: number } | undefined } {
  const level = expiryLevel({ expiresAt }, now);
  const left = expiryLeftMs({ expiresAt }, now);
  const days = left === null || left < 0 ? null : Math.ceil(left / (24 * 3600_000));
  return {
    level,
    days,
    cls: expiryClass(level),
    key: level === 'none' ? null : `acct.expiry.${level}`,
    vars: days === null ? undefined : { days },
  };
}

/** Main account login: Claude Code renews it itself, so it only warns when it is almost over (under 3 days). */
export const MAIN_WARN_MS = 3 * 24 * 3600_000;

export interface MainExpiryView {
  /** auto: renews by itself (neutral text). warn: under 3 days left. expired: past. none: no expiry known. */
  kind: 'auto' | 'warn' | 'expired' | 'none';
  /** Whole days left, rounded up (negative once expired). null when unknown. */
  days: number | null;
  /** Locale date of expiresAt (th-TH in Thai, en-US in English). null when unknown. */
  date: string | null;
}

/** View of the main account's login expiry. Token profiles keep mainExpiry / describeExpiry (30-day warning). */
export function mainExpiryView(expiresAt: number | null, now: number): MainExpiryView {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return { kind: 'none', days: null, date: null };
  const left = expiresAt - now;
  const days = Math.ceil(left / (24 * 3600_000));
  const date = new Date(expiresAt).toLocaleDateString(getLanguage() === 'th' ? 'th-TH' : 'en-US');
  if (left < 0) return { kind: 'expired', days, date };
  if (left < MAIN_WARN_MS) return { kind: 'warn', days, date };
  return { kind: 'auto', days, date };
}

/** i18n key for an error from the main-account logout / login calls, or null to fall back to errText. */
export function mainErrorKey(code: string): string | null {
  return code === 'BUSY_JOBS' ? 'acct.mng.main.err.BUSY_JOBS' : null;
}
