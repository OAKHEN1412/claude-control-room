import { describe, expect, it } from 'vitest';
import { EMPTY_SEEN, charLabel, countInput, detectEvents, pickCharState } from './character';

const base = { waiting: 0, running: 0, errorActive: false, doneActive: false };

describe('pickCharState priority', () => {
  it('idle when nothing happens', () => expect(pickCharState(base)).toBe('idle'));
  it('working when something runs', () => expect(pickCharState({ ...base, running: 2 })).toBe('working'));
  it('done beats working', () => expect(pickCharState({ ...base, running: 1, doneActive: true })).toBe('done'));
  it('error beats done and working', () =>
    expect(pickCharState({ ...base, running: 1, doneActive: true, errorActive: true })).toBe('error'));
  it('waiting beats everything', () =>
    expect(pickCharState({ waiting: 1, running: 3, errorActive: true, doneActive: true })).toBe('asking'));
});

describe('labels', () => {
  it('uses the Thai wording', () => {
    expect(charLabel('idle', { waiting: 0, running: 0 })).toBe('ว่าง');
    expect(charLabel('working', { waiting: 0, running: 3 })).toBe('ทำอยู่ 3 งาน');
    expect(charLabel('asking', { waiting: 2, running: 1 })).toBe('มีคำถามรอ 2');
  });
});

describe('countInput', () => {
  it('queue count wins, else waiting sessions', () => {
    const ss = [{ status: 'running' as const }, { status: 'waiting' as const }];
    expect(countInput(ss, 3)).toEqual({ waiting: 3, running: 1 });
    expect(countInput(ss, 0)).toEqual({ waiting: 1, running: 1 });
  });
});

describe('detectEvents', () => {
  const s = (id: string, status: 'running' | 'idle' | 'done' | 'waiting') => ({ sessionId: id, status });
  it('first look is never an event', () => {
    const r = detectEvents(null, [s('a', 'idle')], [{ sessionId: 'a', failureCount: 5 }]);
    expect(r.done).toBe(false);
    expect(r.error).toBe(false);
  });
  it('running to idle is done; idle to idle is not', () => {
    const first = detectEvents(null, [s('a', 'running')], []).next;
    const r = detectEvents(first, [s('a', 'idle')], []);
    expect(r.done).toBe(true);
    expect(detectEvents(r.next, [s('a', 'idle')], []).done).toBe(false);
  });
  it('running to waiting is not done', () => {
    const first = detectEvents(null, [s('a', 'running')], []).next;
    expect(detectEvents(first, [s('a', 'waiting')], []).done).toBe(false);
  });
  it('a raised failure count is an error, an unchanged one is not', () => {
    const first = detectEvents(null, [], [{ sessionId: 'a', failureCount: 1 }]).next;
    expect(detectEvents(first, [], [{ sessionId: 'a', failureCount: 1 }]).error).toBe(false);
    expect(detectEvents(first, [], [{ sessionId: 'a', failureCount: 2 }]).error).toBe(true);
    expect(detectEvents(first, [], [{ sessionId: 'a', failureCount: 1 }, { sessionId: 'b', failureCount: 1 }]).error).toBe(true);
    expect(detectEvents(first, [], [{ sessionId: 'b', failureCount: 0 }]).error).toBe(false);
  });
  it('EMPTY_SEEN works as a non-first baseline', () => {
    expect(detectEvents(EMPTY_SEEN, [], [{ sessionId: 'a', failureCount: 1 }]).error).toBe(true);
  });
});
