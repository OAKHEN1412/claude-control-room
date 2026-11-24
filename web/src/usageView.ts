// View model for the top-bar usage rings (pure: no DOM, `now` is passed in).
import type { RunnerState, SessionInfo } from '../../shared/protocol';
import { type SessionUsage, type UsageLevel, type UsageQuota, type UsageSnapshot, formatAge, formatCountdown, formatTokens, isStale, levelOf } from '../../shared/usage';

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

function clockTime(t: number, now: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return `วันนี้ ${hm}`;
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${d.getDate()} ${months[d.getMonth()]} ${hm}`;
}

/** "รีเซ็ต วันนี้ 17:00 · อีก 2 ชม. 15 นาที" (local time). */
export function resetLine(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const cd = formatCountdown(resetsAt, now);
  return `รีเซ็ต ${clockTime(resetsAt, now)}${cd ? ` · ${cd}` : ''}`;
}

export function quotaRing(key: 'five' | 'week', q: UsageQuota | null, now: number, modelOf?: (id: string | null) => string | null): RingView {
  const label = key === 'five' ? '5 ชม.' : 'สัปดาห์';
  const title = key === 'five' ? 'โควตา 5 ชั่วโมง' : 'โควตารายสัปดาห์';
  if (!q) return { key, label, title, pct: null, level: 'none', dim: true, text: '–', lines: ['ยังไม่มีข้อมูล (รอ status line ของ Claude Code อัปเดต)'] };
  const expired = q.resetsAt !== null && q.resetsAt <= now;
  const stale = isStale(q.updatedAt, now);
  const lines = [`ใช้ไป ${Math.round(q.pct)}%`];
  const r = resetLine(q.resetsAt, now);
  if (r) lines.push(r);
  const model = q.model ?? modelOf?.(q.sessionId) ?? null;
  if (model || q.sessionId) lines.push(`จาก: ${[model, q.sessionId ? `session ${q.sessionId.slice(0, 8)}` : null].filter(Boolean).join(' · ')}`);
  lines.push(`อัปเดตล่าสุด ${formatAge(q.updatedAt, now)}${stale ? ' (ข้อมูลเก่า)' : ''}`);
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
  if (!session || session.ctxPct === null) return { ...base, pct: null, level: 'none', dim: true, text: '–', lines: ['ยังไม่มีข้อมูล context ของ session ที่เปิดอยู่'] };
  const pct = session.ctxPct;
  const stale = isStale(session.updatedAt, now);
  const approx = session.estimated ? ' (ประมาณ)' : '';
  const lines = [`${Math.round(pct)}%${approx}`];
  if (session.ctxUsed !== null && session.ctxWindow !== null) lines.push(`${formatTokens(session.ctxUsed)} / ${formatTokens(session.ctxWindow)} โทเค็น${approx}`);
  lines.push(`${selectedFollowed ? 'session ที่เลือก' : 'session ล่าสุด'}: ${nameOf(session.sessionId)}${session.model ? ` · ${session.model}` : ''}`);
  lines.push(`อัปเดตล่าสุด ${formatAge(session.updatedAt, now)}${stale ? ' (ข้อมูลเก่า)' : ''}`);
  return { ...base, pct, level: levelOf(pct), dim: stale, text: String(Math.round(pct)), lines };
}
