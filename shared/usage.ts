// Usage meters for the top bar: 5-hour quota, weekly quota, and the context window of a session.
// Pure helpers shared by the server (usage.ts) and the web (UsageRings). No I/O here.

/** One account quota window (the 5-hour or the 7-day one). */
export interface UsageQuota {
  pct: number; // 0..100 used
  resetsAt: number | null; // epoch ms the window resets
  updatedAt: number; // epoch ms the number was last written
  sessionId: string | null; // session whose status line / stream produced it
  model: string | null; // that session's model (display name or id)
}

/** Context window of one session. */
export interface SessionUsage {
  sessionId: string;
  model: string | null;
  ctxPct: number | null; // 0..100 of the window; null = unknown
  ctxUsed: number | null; // tokens in the window
  ctxWindow: number | null; // window size in tokens
  estimated: boolean; // derived from the last message's usage, not read from the status line
  updatedAt: number;
}

export interface UsageSnapshot {
  fiveHour: UsageQuota | null;
  sevenDay: UsageQuota | null;
  sessions: SessionUsage[]; // newest first
}

export const EMPTY_USAGE: UsageSnapshot = { fiveHour: null, sevenDay: null, sessions: [] };

/** Older than this the number is shown dimmed with "อัปเดตล่าสุด …". */
export const USAGE_STALE_MS = 10 * 60_000;
export const WARN_PCT = 70;
export const CRIT_PCT = 90;

export type UsageLevel = 'ok' | 'warn' | 'crit';

export function levelOf(pct: number): UsageLevel {
  return pct >= CRIT_PCT ? 'crit' : pct >= WARN_PCT ? 'warn' : 'ok';
}

export function isStale(updatedAt: number, now: number): boolean {
  return now - updatedAt > USAGE_STALE_MS;
}

/** Epoch seconds (what the CLI sends) or milliseconds -> milliseconds. */
export function toMs(t: unknown): number | null {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return null;
  return t < 1e12 ? Math.round(t * 1000) : Math.round(t);
}

/** "อีก 2 ชม. 15 นาที" / "อีก 12 นาที" / "รีเซ็ตแล้ว"; null when the reset time is unknown. */
export function formatCountdown(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const diff = Math.floor((resetsAt - now) / 60_000);
  if (diff <= 0) return 'รีเซ็ตแล้ว';
  const d = Math.floor(diff / 1440);
  const h = Math.floor((diff % 1440) / 60);
  const m = diff % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d} วัน`);
  if (h > 0) parts.push(`${h} ชม.`);
  if (m > 0 && d === 0) parts.push(`${m} นาที`);
  return `อีก ${parts.join(' ')}`;
}

/** 319_000 -> "319k", 1_000_000 -> "1.0m", 850 -> "850". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** "5 นาทีที่แล้ว" style age for the "อัปเดตล่าสุด" line. */
export function formatAge(updatedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (s < 60) return `${s} วินาทีที่แล้ว`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ชม. ที่แล้ว`;
  return `${Math.floor(h / 24)} วันที่แล้ว`;
}

/**
 * Context window size for a model when the status line did not tell us.
 * Every 5.x model shows a 1.0m window on the status line; an explicit "[1m]" suffix too; anything else 200k.
 */
export function contextWindowFor(model: string | null | undefined): number {
  const m = (model ?? '').toLowerCase();
  if (/\[1m\]/.test(m) || /\b5\.\d\b/.test(m) || /-5-\d/.test(m)) return 1_000_000;
  return 200_000;
}

/** Tokens in the context after one assistant message: input + cache creation + cache read. */
export function contextTokensFromUsage(u: unknown): number | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const n = (k: string): number => (typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? (o[k] as number) : 0);
  const total = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
  return total > 0 ? total : null;
}

/** Context of a session derived from an assistant message's usage. `window` wins over the model table. */
export function deriveContext(sessionId: string, model: string | null, usage: unknown, updatedAt: number, window?: number | null): SessionUsage | null {
  const used = contextTokensFromUsage(usage);
  if (used === null) return null;
  const size = window && window > 0 ? window : contextWindowFor(model);
  return { sessionId, model, ctxPct: Math.min(100, (used / size) * 100), ctxUsed: used, ctxWindow: size, estimated: true, updatedAt };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * One <session>.trigger.json written by ~/.claude/statusline.js. Old files only carry ctx / five_hour / seven_day
 * (0 when the status line had no number); new ones add updated_at, model, *_resets_at, ctx_tokens, ctx_window.
 * Returns the session's context plus the quotas it knows; missing fields stay null.
 */
export function parseTrigger(
  raw: unknown,
  fileMtimeMs: number,
  fallbackSessionId: string,
): { session: SessionUsage; fiveHour: UsageQuota | null; sevenDay: UsageQuota | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sessionId = str(o.session_id) ?? fallbackSessionId;
  const updatedAt = num(o.updated_at) ?? fileMtimeMs;
  const model = str(o.model);
  const ctx = num(o.ctx);
  const ctxUsed = num(o.ctx_tokens);
  const ctxWindow = num(o.ctx_window);
  const ctxKnown = ctxUsed !== null || ctxWindow !== null || (ctx !== null && ctx > 0);
  const ctxPct = ctxKnown ? (ctx ?? (ctxUsed !== null && ctxWindow ? (ctxUsed / ctxWindow) * 100 : null)) : null;
  const session: SessionUsage = { sessionId, model, ctxPct, ctxUsed, ctxWindow, estimated: false, updatedAt };
  // The status line gave only a percentage: size the window from the model table and label the token count as an estimate.
  if (ctxPct !== null && ctxUsed === null && ctxWindow === null && (model ?? str(o.model_id))) {
    const w = contextWindowFor(str(o.model_id) ?? model);
    session.ctxWindow = w;
    session.ctxUsed = Math.round((ctxPct / 100) * w);
    session.estimated = true;
  }
  const quota = (pctKey: string, resetKey: string): UsageQuota | null => {
    const pct = num(o[pctKey]);
    const resetsAt = toMs(o[resetKey]);
    if (pct === null || (pct <= 0 && resetsAt === null)) return null; // 0 with no reset time = "no number", not "0 %"
    return { pct, resetsAt, updatedAt, sessionId, model };
  };
  return { session, fiveHour: quota('five_hour', 'five_hour_resets_at'), sevenDay: quota('seven_day', 'seven_day_resets_at') };
}

/** The fresher of two optional quotas (newest updatedAt wins; a tie keeps `a`). */
export function freshest(a: UsageQuota | null, b: UsageQuota | null): UsageQuota | null {
  if (!a) return b;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

/** One entry per session id, the newest wins. Result newest first. */
export function mergeSessions(list: SessionUsage[]): SessionUsage[] {
  const by = new Map<string, SessionUsage>();
  for (const s of list) {
    const cur = by.get(s.sessionId);
    if (!cur || s.updatedAt > cur.updatedAt) by.set(s.sessionId, s);
  }
  return [...by.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A rate_limit_event from the stream-json output of `claude -p`:
 * rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization 0..1, resetsAt epoch s}.
 */
export function parseRateLimitEvent(ev: unknown, sessionId: string | null, now: number): { fiveHour: UsageQuota | null; sevenDay: UsageQuota | null } {
  const out = { fiveHour: null as UsageQuota | null, sevenDay: null as UsageQuota | null };
  if (!ev || typeof ev !== 'object') return out;
  const info = (ev as Record<string, unknown>).rate_limit_info;
  if (!info || typeof info !== 'object') return out;
  const w = (info as Record<string, unknown>).unifiedWindows;
  if (!w || typeof w !== 'object') return out;
  const mk = (x: unknown): UsageQuota | null => {
    if (!x || typeof x !== 'object') return null;
    const u = num((x as Record<string, unknown>).utilization);
    if (u === null) return null;
    return { pct: Math.max(0, Math.min(100, u * 100)), resetsAt: toMs((x as Record<string, unknown>).resetsAt), updatedAt: now, sessionId, model: null };
  };
  out.fiveHour = mk((w as Record<string, unknown>).five_hour);
  out.sevenDay = mk((w as Record<string, unknown>).seven_day);
  return out;
}
