import { useEffect, useRef, useState } from 'react';
import type { SessionInfo, WorklogCard } from '../../shared/protocol';
import { DONE_MS, ERROR_MS, charLabel, countInput, detectEvents, pickCharState, type CharState, type Seen } from './character';

export interface CharView {
  state: CharState;
  label: string;
  waiting: number;
  running: number;
}

/** Feeds the character from live data. ready = the first server message has arrived (no events before that). */
export function useCharacter(sessions: SessionInfo[], cards: WorklogCard[], queueCount: number, ready: boolean): CharView {
  const seen = useRef<Seen | null>(null);
  const [errorUntil, setErrorUntil] = useState(0);
  const [doneUntil, setDoneUntil] = useState(0);
  const [, tick] = useState(0);
  // The snapshot, clips and worklog messages arrive one after another; wait until they settle before
  // taking the baseline, so the first card list is not read as a new failure.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setArmed(true), 1500);
    return () => clearTimeout(t);
  }, [ready]);

  useEffect(() => {
    if (!armed) return;
    const r = detectEvents(seen.current, sessions, cards);
    seen.current = r.next;
    const now = Date.now();
    if (r.error) {
      setErrorUntil(now + ERROR_MS);
      setTimeout(() => tick((n) => n + 1), ERROR_MS + 50);
    }
    if (r.done) {
      setDoneUntil(now + DONE_MS);
      setTimeout(() => tick((n) => n + 1), DONE_MS + 50);
    }
  }, [sessions, cards, armed]);

  const now = Date.now();
  const counts = countInput(sessions, queueCount);
  const state = pickCharState({ ...counts, errorActive: now < errorUntil, doneActive: now < doneUntil });
  return { state, label: charLabel(state, counts), ...counts };
}
