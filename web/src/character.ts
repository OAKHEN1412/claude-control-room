// Stage 6: what the Claude character shows. Pure functions; the hook that feeds them is in useCharacter.ts.
// Priority: waiting for the user > error just happened > done just happened > working > idle.
import type { SessionInfo, Status, WorklogCard } from '../../shared/protocol';

export type CharState = 'idle' | 'working' | 'asking' | 'error' | 'done';

export const ERROR_MS = 3000; // red-pink shake after a new failure
export const DONE_MS = 1400; // happy hop after a session finished

export interface CharInput {
  waiting: number; // questions waiting for the user (queue size, or waiting sessions when the queue is empty)
  running: number; // sessions / clip jobs working
  errorActive: boolean;
  doneActive: boolean;
}

export function pickCharState(i: CharInput): CharState {
  if (i.waiting > 0) return 'asking';
  if (i.errorActive) return 'error';
  if (i.doneActive) return 'done';
  if (i.running > 0) return 'working';
  return 'idle';
}

export function charLabel(state: CharState, i: Pick<CharInput, 'waiting' | 'running'>): string {
  switch (state) {
    case 'asking':
      return `มีคำถามรอ ${i.waiting}`;
    case 'error':
      return 'งานล้มเหลว';
    case 'done':
      return 'เสร็จแล้ว';
    case 'working':
      return `ทำอยู่ ${i.running} งาน`;
    default:
      return 'ว่าง';
  }
}

/** Counts for the state: queue items count first; terminal sessions that wait count when the queue has none. */
export function countInput(sessions: ReadonlyArray<{ status: Status }>, queueCount: number): Pick<CharInput, 'waiting' | 'running'> {
  const waitingSessions = sessions.filter((s) => s.status === 'waiting').length;
  return {
    waiting: queueCount > 0 ? queueCount : waitingSessions,
    running: sessions.filter((s) => s.status === 'running').length,
  };
}

export interface Seen {
  status: Map<string, Status>;
  failures: Map<string, number>;
}

export const EMPTY_SEEN: Seen = { status: new Map(), failures: new Map() };

/**
 * Compares the new data with what was seen before. done: a session went running -> idle/done.
 * error: the failure count of a worklog card went up (or a new card arrived with failures).
 * prev === null is the first look (page just connected): nothing counts as an event.
 */
export function detectEvents(
  prev: Seen | null,
  sessions: ReadonlyArray<Pick<SessionInfo, 'sessionId' | 'status'>>,
  cards: ReadonlyArray<Pick<WorklogCard, 'sessionId' | 'failureCount'>>,
): { done: boolean; error: boolean; next: Seen } {
  const next: Seen = {
    status: new Map(sessions.map((s) => [s.sessionId, s.status])),
    failures: new Map(cards.map((c) => [c.sessionId, c.failureCount])),
  };
  if (!prev) return { done: false, error: false, next };
  let done = false;
  let error = false;
  for (const [id, st] of next.status) {
    if (prev.status.get(id) === 'running' && (st === 'idle' || st === 'done')) done = true;
  }
  for (const [id, n] of next.failures) {
    if (n > (prev.failures.get(id) ?? 0)) error = true;
  }
  return { done, error, next };
}
