// View model for the top-bar usage rings (pure: no DOM, `now` is passed in).
import { TERMINAL_ACCOUNT_ID, type AccountInfo, type AccountUsage, type AccountUsageWindow } from '../../shared/accounts';
import type { RunnerState, SessionInfo } from '../../shared/protocol';
import { type SessionUsage, type UsageLevel, type UsageQuota, type UsageSnapshot, ageMsg, countdownMsg, formatTokens, isStale, levelOf } from '../../shared/usage';
import { t, type TKey } from './i18n';
import { serverCode } from './i18n/serverMsg';

const MONTH_KEYS: TKey[] = [
  'shell.usage.month1', 'shell.usage.month2', 'shell.usage.month3', 'shell.usage.month4', 'shell.usage.month5', 'shell.usage.month6',
  'shell.usage.month7', 'shell.usage.month8', 'shell.usage.month9', 'shell.usage.month10', 'shell.usage.month11', 'shell.usage.month12',
];

export interface RingView {
  key: 'five' | 'week' | 'ctx';
  label: string; // short label beside the ring
  title: string; // popover heading
  pct: number | null; // null = no number yet
  level: UsageLevel | 'none';
  dim: boolean; // stale or the window has already reset
  text: string; // inside the ring
  lines: string[]; // popover detail
}

function clockTime(at: number, now: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return t('shell.usage.today', { hm });
  return `${d.getDate()} ${t(MONTH_KEYS[d.getMonth()])} ${hm}`;
}

/** "Resets today 17:00 · in 2 h 15 min" (local time). */
export function resetLine(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const cd = countdownMsg(resetsAt, now);
  const cdText = cd ? serverCode(cd.code, cd.vars, cd.text) : '';
  return `${t('shell.usage.resetAt', { time: clockTime(resetsAt, now) })}${cdText ? ` · ${cdText}` : ''}`;
}

/** "5 นาทีที่แล้ว" / "5 min ago" for the "อัปเดตล่าสุด" line, in the current language. */
function ageText(at: number, now: number): string {
  const a = ageMsg(at, now);
  return serverCode(a.code, a.vars, a.text);
}

export function quotaRing(key: 'five' | 'week', q: UsageQuota | null, now: number, modelOf?: (id: string | null) => string | null): RingView {
  const label = key === 'five' ? t('shell.usage.window5h') : t('shell.usage.windowWeek');
  const title = key === 'five' ? t('shell.usage.title5h') : t('shell.usage.titleWeek');
  if (!q) return { key, label, title, pct: null, level: 'none', dim: true, text: '–', lines: [t('shell.usage.noQuota')] };
  const expired = q.resetsAt !== null && q.resetsAt <= now;
  const stale = isStale(q.updatedAt, now);
  const lines = [t('shell.usage.used', { pct: Math.round(q.pct) })];
  const r = resetLine(q.resetsAt, now);
  if (r) lines.push(r);
  const model = q.model ?? modelOf?.(q.sessionId) ?? null;
  if (model || q.sessionId) lines.push(`${t('shell.usage.from')} ${[model, q.sessionId ? `session ${q.sessionId.slice(0, 8)}` : null].filter(Boolean).join(' · ')}`);
  lines.push(`${t('shell.usage.updatedAt', { age: ageText(q.updatedAt, now) })}${stale ? t('shell.usage.stale') : ''}`);
  return { key, label, title, pct: q.pct, level: levelOf(q.pct), dim: stale || expired, text: String(Math.round(q.pct)), lines };
}

/** Sessions the browser counts as live: not finished, not unreadable, or a Runner child still running. */
export function liveSessionIds(sessions: SessionInfo[], runners: Record<string, RunnerState>): Set<string> {
  const ids = new Set<string>();
  for (const s of sessions) if (s.status !== 'done' && s.status !== 'unreadable') ids.add(s.sessionId);
  for (const r of Object.values(runners)) if (r.alive) ids.add(r.sessionId);
  return ids;
}

/** The session the context ring follows: the selected one if it has usage, else the most recently updated live one. */
export function pickContext(usage: UsageSnapshot, selectedId: string | null, live: Set<string>): { session: SessionUsage | null; rows: SessionUsage[] } {
  const rows = usage.sessions.filter((s) => live.has(s.sessionId) && s.ctxPct !== null);
  const chosen = (selectedId ? rows.find((s) => s.sessionId === selectedId) : undefined) ?? rows[0] ?? null;
  return { session: chosen, rows: rows.slice(0, 8) };
}

export function contextRing(session: SessionUsage | null, selectedFollowed: boolean, now: number, nameOf: (id: string) => string): RingView {
  const base = { key: 'ctx' as const, label: 'Context', title: 'Context window' };
  if (!session || session.ctxPct === null) return { ...base, pct: null, level: 'none', dim: true, text: '–', lines: [t('shell.usage.noContext')] };
  const pct = session.ctxPct;
  const stale = isStale(session.updatedAt, now);
  const approx = session.estimated ? t('shell.usage.approx') : '';
  const lines = [`${Math.round(pct)}%${approx}`];
  if (session.ctxUsed !== null && session.ctxWindow !== null) lines.push(`${t('shell.usage.tokens', { used: formatTokens(session.ctxUsed), window: formatTokens(session.ctxWindow) })}${approx}`);
  lines.push(`${t(selectedFollowed ? 'shell.usage.selectedSession' : 'shell.usage.latestSession')}: ${nameOf(session.sessionId)}${session.model ? ` · ${session.model}` : ''}`);
  lines.push(`${t('shell.usage.updatedAt', { age: ageText(session.updatedAt, now) })}${stale ? t('shell.usage.stale') : ''}`);
  return { ...base, pct, level: levelOf(pct), dim: stale, text: String(Math.round(pct)), lines };
}

/** One profile window as a ring quota (its updatedAt is the profile's); null when the window is unknown. */
export function profileQuota(w: AccountUsageWindow | null, updatedAt: number): UsageQuota | null {
  if (!w) return null;
  return { pct: w.pct, resetsAt: w.resetsAt, updatedAt, sessionId: null, model: null };
}

/** A profile's usage in the global snapshot's shape. No usage -> both windows null; sessions are kept from the global snapshot. */
export function usageForProfile(global: UsageSnapshot, usage: AccountUsage | null): UsageSnapshot {
  const at = usage?.updatedAt ?? 0;
  return {
    fiveHour: profileQuota(usage?.fiveHour ?? null, at),
    sevenDay: profileQuota(usage?.sevenDay ?? null, at),
    sessions: global.sessions,
  };
}

/** The snapshot the rings show for the header profile: the global one for Terminal, the profile's own usage otherwise. */
export function effectiveUsage(global: UsageSnapshot, accountId: string, accounts: AccountInfo[]): UsageSnapshot {
  if (accountId === TERMINAL_ACCOUNT_ID) return global;
  const profile = accounts.find((a) => a.id === accountId);
  return usageForProfile(global, profile?.usage ?? null);
}

/** True when a non-Terminal header profile has no usage record yet (an unknown profile counts as not yet fetched). */
export function awaitingProfileUsage(accountId: string, accounts: AccountInfo[]): boolean {
  if (accountId === TERMINAL_ACCOUNT_ID) return false;
  return accounts.find((a) => a.id === accountId)?.usage == null;
}

/** Tooltip line naming the header profile ("โปรไฟล์: <name>"); Terminal uses its own display name. */
export function profileLabel(accountId: string, accounts: AccountInfo[]): string {
  const name = accountId === TERMINAL_ACCOUNT_ID ? t('acct.terminal.name') : (accounts.find((a) => a.id === accountId)?.name ?? accountId);
  return t('acct.usage.profile', { name });
}

/** Adds the profile line to a quota ring's tooltip; while the profile awaits its first usage, shows the fetching text instead of the no-quota text. */
export function withProfile(view: RingView, label: string, fetching: boolean): RingView {
  const lines = fetching ? [t('acct.usage.fetching')] : view.lines;
  return { ...view, lines: [...lines, label] };
}
