import type { SessionInfo } from '../../shared/protocol';

const ACTIVE: ReadonlySet<SessionInfo['status']> = new Set(['running', 'waiting']);

/**
 * Resolves which session ids the two panes show. A picked id that still exists wins;
 * otherwise the pane takes the first running/waiting session not used by the other pane.
 */
export function resolvePanes(
  sessions: readonly SessionInfo[],
  pick1: string | null,
  pick2: string | null,
): [string | null, string | null] {
  const exists = (id: string | null) => id !== null && sessions.some((s) => s.sessionId === id);
  let a = exists(pick1) ? pick1 : null;
  let b = exists(pick2) ? pick2 : null;
  const active = sessions.filter((s) => ACTIVE.has(s.status)).map((s) => s.sessionId);
  if (a === null) a = active.find((id) => id !== b) ?? null;
  if (b === null) b = active.find((id) => id !== a) ?? null;
  return [a, b];
}
