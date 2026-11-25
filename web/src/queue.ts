// Stage 3: one question/permission queue across ALL sessions. Pure functions, no React.
//  - runner items: held can_use_tool requests of sessions the web controls (answerable);
//  - terminal items: unanswered prompts the watcher sees in a terminal session (read-only).
import type { AskQuestion, PendingRequest, RunnerState, SessionInfo, WaitItem } from '../../shared/protocol';
import { cwdTail } from './control';
import { t } from './i18n';

export interface QueueItem {
  key: string; // stable id: "r:<sessionId>:<requestId>" or "t:<sessionId>:<toolUseId>"
  source: 'runner' | 'terminal';
  sessionId: string;
  job: string; // job title for the popup heading
  model: string; // short model name, '' when unknown
  kind: 'ask' | 'permission';
  toolName: string;
  label: string; // Thai label (permission: tool + detail)
  detail: string;
  text: string; // first line of the question / what is being asked
  questions: AskQuestion[];
  requestId: string | null; // runner only
  at: number; // when the request was raised (epoch ms), used for ordering
}

/** "เขียนไฟล์: a.txt" -> "เขียนไฟล์". */
export function labelHead(label: string): string {
  const k = label.indexOf(': ');
  return k >= 0 ? label.slice(0, k) : label;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** "claude-haiku-5-5" -> "Haiku 5.5", "opus" -> "Opus". */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  const m = /(opus|sonnet|haiku|fable)(?:[-\s]*(\d+)[-.](\d+))?/i.exec(model);
  if (!m) return model;
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return m[2] ? `${name} ${m[2]}.${m[3]}` : name;
}

function jobName(s: SessionInfo | undefined, cwd: string): string {
  const t = s ? oneLine(s.title || s.name) : '';
  if (t && t !== '(ไม่มีชื่อ)') return t.length > 40 ? `${t.slice(0, 39)}…` : t;
  return s?.name || cwdTail(s?.cwd ?? cwd);
}

function fromPending(p: PendingRequest, r: RunnerState, s: SessionInfo | undefined): QueueItem {
  const questions = p.kind === 'ask' ? (p.questions ?? []) : [];
  const label = p.label ?? p.toolName;
  return {
    key: `r:${r.sessionId}:${p.requestId}`,
    source: 'runner',
    sessionId: r.sessionId,
    job: jobName(s, r.cwd),
    model: shortModel(r.model ?? s?.model),
    kind: p.kind,
    toolName: p.toolName,
    label,
    detail: p.detail ?? '',
    text: p.kind === 'ask' ? (questions[0]?.question ?? p.description) : t('shell.queue.permission', { what: labelHead(label) }),
    questions,
    requestId: p.requestId,
    at: p.at,
  };
}

function fromWait(w: WaitItem, s: SessionInfo): QueueItem {
  const questions = w.kind === 'ask' ? (w.questions ?? []) : [];
  return {
    key: `t:${s.sessionId}:${w.id}`,
    source: 'terminal',
    sessionId: s.sessionId,
    job: jobName(s, s.cwd),
    model: shortModel(s.model),
    kind: w.kind,
    toolName: w.toolName,
    label: w.label,
    detail: w.detail,
    text: w.kind === 'ask' ? (questions[0]?.question ?? w.detail) : labelHead(w.label),
    questions,
    requestId: null,
    at: w.at,
  };
}

/** Every unanswered prompt right now. A session the web controls is represented by its Runner only. */
export function collectItems(sessions: readonly SessionInfo[], runners: Readonly<Record<string, RunnerState>>): QueueItem[] {
  const out: QueueItem[] = [];
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]));
  for (const r of Object.values(runners)) {
    if (!r.alive) continue;
    for (const p of r.pending) out.push(fromPending(p, r, bySession.get(r.sessionId)));
  }
  for (const s of sessions) {
    if (s.status === 'done' || s.status === 'unreadable') continue;
    if (runners[s.sessionId]?.alive) continue;
    for (const w of s.waitItems ?? []) out.push(fromWait(w, s));
  }
  return out;
}

/** Oldest first; ties keep the order the items were first seen. */
export function sortQueue(items: QueueItem[], firstSeen: ReadonlyMap<string, number> = new Map()): QueueItem[] {
  return [...items].sort((a, b) => a.at - b.at || (firstSeen.get(a.key) ?? 0) - (firstSeen.get(b.key) ?? 0) || (a.key < b.key ? -1 : 1));
}

export interface QueueState {
  items: QueueItem[]; // oldest first
  added: string[]; // keys that appeared in the last update (for notifications)
  seen: Record<string, number>; // key -> update counter when first seen
  tick: number;
}

export const EMPTY_QUEUE: QueueState = { items: [], added: [], seen: {}, tick: 0 };

/**
 * Reducer: `incoming` is the full list of prompts the server shows now.
 * Items no longer present (answered here, in the pane, or in the terminal) disappear at once;
 * new ones are reported in `added`; the result is sorted oldest first.
 */
export function updateQueue(prev: QueueState, incoming: QueueItem[]): QueueState {
  if (prev.added.length === 0 && JSON.stringify(prev.items) === JSON.stringify(sortQueue(incoming, new Map(Object.entries(prev.seen))))) {
    return prev; // nothing changed: keep identity so React does not re-render
  }
  const tick = prev.tick + 1;
  const seen: Record<string, number> = {};
  const added: string[] = [];
  for (const it of incoming) {
    if (it.key in prev.seen) seen[it.key] = prev.seen[it.key];
    else {
      seen[it.key] = tick;
      added.push(it.key);
    }
  }
  const items = sortQueue(incoming, new Map(Object.entries(seen)));
  return { items, added, seen, tick };
}

/** Index of the option shown filled (recommended): a label that says so, else the first. */
export function recommendedIndex(options: readonly { label: string }[]): number {
  const i = options.findIndex((o) => /recommended|แนะนำ/i.test(o.label));
  return i >= 0 ? i : 0;
}

/** Option marker: Thai letters in Thai, A, B, C... in English (letters come from the dictionary). */
export const optionLetter = (i: number): string => [...t('shell.queue.letters')][i] ?? String(i + 1);

/** Count line announced to screen readers. */
export function countText(n: number): string {
  return n === 0 ? t('shell.queue.none') : t('shell.queue.count', { n });
}

export function titleWithCount(base: string, n: number): string {
  return n > 0 ? `(${n}) ${base}` : base;
}

/** Notification text: job title + first line of the question. */
export function notificationText(it: QueueItem): { title: string; body: string } {
  const first = oneLine(it.text.split(/\r?\n/).find((l) => l.trim()) ?? it.text);
  return {
    title: it.kind === 'ask' ? t('shell.queue.askFrom', { job: it.job }) : t('shell.queue.permissionFrom', { job: it.job }),
    body: first.length > 140 ? `${first.slice(0, 139)}…` : first,
  };
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export type Placement = 'corner' | 'top' | 'bottom';

/**
 * The popup sits in the top-right corner under the header. When that would cover the focused control it
 * goes to the strip under the header (full width); when that covers it too, to the bottom strip.
 * `top`/`bottom` are the boxes the two strips would occupy.
 */
export function choosePlacement(corner: Box, focused: Box | null, top?: Box, bottom?: Box): Placement {
  if (!focused || !boxesOverlap(corner, focused)) return 'corner';
  if (!top || !boxesOverlap(top, focused)) return 'top';
  if (bottom && !boxesOverlap(bottom, focused)) return 'bottom';
  return 'top';
}
