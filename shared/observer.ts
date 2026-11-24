// Stage 4: deterministic answers for the summary assistant's chips. Pure, shared by the web (instant, no
// server round trip) and the server tests. No model is involved: "เสร็จยัง" comes from session statuses and
// "มีอะไรรอฉัน" from the wait queue (runner requests for web-controlled sessions, transcript wait items otherwise).
import type { RunnerState, SessionInfo } from './protocol';

export type ChipId = 'done' | 'waiting' | 'today';
export interface Chip {
  id: ChipId;
  label: string;
  model: boolean; // true = needs a Haiku call
}
export const CHIPS: readonly Chip[] = [
  { id: 'done', label: 'เสร็จยัง', model: false },
  { id: 'waiting', label: 'มีอะไรรอฉัน', model: false },
  { id: 'today', label: 'สรุปงานวันนี้', model: true },
];
/** The question text sent to Haiku for the "สรุปงานวันนี้" chip. */
export const TODAY_QUESTION = 'สรุปงานวันนี้';

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function cwdName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Short job name: title, else session name, else folder. */
export function jobTitle(s: Pick<SessionInfo, 'title' | 'name' | 'cwd'>): string {
  const t = oneLine(s.title || '');
  if (t && t !== '(ไม่มีชื่อ)') return clip(t, 50);
  return s.name || cwdName(s.cwd);
}

export interface WaitLine {
  sessionId: string;
  job: string;
  kind: 'ask' | 'permission';
  text: string; // what is being asked, one line
  at: number;
}

/** Every unanswered prompt right now; a session the web controls is represented by its Runner only. */
export function waitLines(sessions: readonly SessionInfo[], runners: Readonly<Record<string, RunnerState>>): WaitLine[] {
  const out: WaitLine[] = [];
  const by = new Map(sessions.map((s) => [s.sessionId, s]));
  const viaRunner = new Set<string>();
  for (const r of Object.values(runners)) {
    if (!r.alive) continue;
    viaRunner.add(r.sessionId);
    const s = by.get(r.sessionId);
    const job = s ? jobTitle(s) : cwdName(r.cwd);
    for (const p of r.pending) {
      const text = p.kind === 'ask' ? (p.questions?.[0]?.question ?? p.description) : `ขออนุญาต ${p.label ?? p.toolName}`;
      out.push({ sessionId: r.sessionId, job, kind: p.kind, text: clip(oneLine(text), 120), at: p.at });
    }
  }
  for (const s of sessions) {
    if (viaRunner.has(s.sessionId) || s.status === 'done') continue;
    for (const w of s.waitItems ?? []) {
      const text = w.kind === 'ask' ? (w.questions?.[0]?.question ?? w.detail ?? w.label) : `${w.label}${w.detail ? `: ${w.detail}` : ''}`;
      out.push({ sessionId: s.sessionId, job: jobTitle(s), kind: w.kind, text: clip(oneLine(text), 120), at: w.at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface StatusCounts {
  running: number;
  waiting: number;
  idle: number;
  done: number;
  unreadable: number;
}

export function countStatuses(sessions: readonly SessionInfo[]): StatusCounts {
  const c: StatusCounts = { running: 0, waiting: 0, idle: 0, done: 0, unreadable: 0 };
  for (const s of sessions) c[s.status]++;
  return c;
}

/** One status line for the top of the widget. */
export function statusLine(sessions: readonly SessionInfo[], runners: Readonly<Record<string, RunnerState>> = {}): string {
  if (sessions.length === 0) return 'ยังไม่มีงานที่เปิดอยู่';
  const c = countStatuses(sessions);
  const parts: string[] = [];
  if (c.running) parts.push(`กำลังทำ ${c.running}`);
  const w = waitLines(sessions, runners).length;
  if (w) parts.push(`รอคุณ ${w} คำถาม`);
  else if (c.waiting) parts.push(`รอคุณ ${c.waiting} งาน`);
  if (c.idle) parts.push(`พักอยู่ ${c.idle}`);
  if (c.done) parts.push(`จบแล้ว ${c.done}`);
  if (c.unreadable) parts.push(`อ่านไม่ได้ ${c.unreadable}`);
  return parts.join(' · ') || 'ไม่มีความเคลื่อนไหว';
}

const MAX_LIST = 6;
const list = (lines: string[]): string => {
  const shown = lines.slice(0, MAX_LIST);
  if (lines.length > MAX_LIST) shown.push(`…และอีก ${lines.length - MAX_LIST} งาน`);
  return shown.join('\n');
};

/** "เสร็จยัง": answered from the session statuses. */
export function doneAnswer(sessions: readonly SessionInfo[], runners: Readonly<Record<string, RunnerState>> = {}): string {
  const live = sessions.filter((s) => s.status !== 'done' && s.status !== 'unreadable');
  if (live.length === 0) return sessions.length === 0 ? 'ยังไม่มีงานที่เปิดอยู่' : 'ไม่มีงานที่ยังเปิดอยู่ ทุกงานจบแล้ว';
  const busy = live.filter((s) => s.status === 'running');
  const wait = live.filter((s) => s.status === 'waiting');
  const idle = live.filter((s) => s.status === 'idle');
  if (busy.length === 0 && wait.length === 0) {
    return `ยัง ไม่มีงานที่กำลังทำ — ทุกงานหยุดรอ (${idle.length} งาน)\n${list(idle.map((s) => `• ${jobTitle(s)}`))}`;
  }
  const head = `ยังไม่เสร็จ: กำลังทำ ${busy.length} งาน, รอคุณ ${wait.length} งาน, พักอยู่ ${idle.length} งาน`;
  const lines = [
    ...busy.map((s) => `• ${jobTitle(s)} — กำลังทำ${s.thought ? `: ${clip(oneLine(s.thought), 70)}` : ''}`),
    ...wait.map((s) => `• ${jobTitle(s)} — รอคุณ`),
  ];
  void runners;
  return `${head}\n${list(lines)}`;
}

/** "มีอะไรรอฉัน": answered from the wait queue. */
export function waitingAnswer(sessions: readonly SessionInfo[], runners: Readonly<Record<string, RunnerState>> = {}): string {
  const items = waitLines(sessions, runners);
  if (items.length === 0) return 'ไม่มีอะไรรอคุณ';
  const head = `รอคุณ ${items.length} เรื่อง`;
  return `${head}\n${list(items.map((i) => `• ${i.job} — ${i.kind === 'ask' ? 'ถาม' : 'ขออนุญาต'}: ${i.text}`))}`;
}

/** Deterministic answer for a chip; null when the chip needs the model. */
export function chipAnswer(
  id: ChipId,
  sessions: readonly SessionInfo[],
  runners: Readonly<Record<string, RunnerState>> = {},
): string | null {
  if (id === 'done') return doneAnswer(sessions, runners);
  if (id === 'waiting') return waitingAnswer(sessions, runners);
  return null;
}
