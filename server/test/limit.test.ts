import { describe, it, expect } from 'vitest';
import { createState, derive, ingestLine } from '../src/parser';
import { LIMIT_TEXT_RE, limitLabel } from '../../shared/protocol';

const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

const apiError = (text: string, sec: number) =>
  JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    uuid: `u${sec}`,
    timestamp: at(sec),
    message: { model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text }] },
  });
const normal = (text: string, sec: number) =>
  JSON.stringify({ type: 'assistant', timestamp: at(sec), message: { model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const toolUse = (sec: number) =>
  JSON.stringify({ type: 'assistant', timestamp: at(sec), message: { model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });

const LIMIT = "You've hit your 5-hour limit · resets 1:30pm (Asia/Bangkok)";
const view = (lines: string[]) => {
  const st = createState();
  for (const l of lines) ingestLine(st, l);
  return derive(st, { now: T0 + 3_600_000, processAlive: true });
};

describe('usage limit', () => {
  it('a limit api error sets session.limit and marks the timeline event', () => {
    const d = view([normal('hello', 0), apiError(LIMIT, 5)]);
    expect(d.limit).toEqual({ text: LIMIT, at: T0 + 5000 });
    const last = d.timeline[d.timeline.length - 1];
    expect(last).toMatchObject({ kind: 'text', text: LIMIT, tone: 'limit' });
    expect(d.timeline[0].tone).toBeUndefined();
  });

  it('a later normal assistant turn (text or tool call) clears it; the old event stays red', () => {
    const afterText = view([apiError(LIMIT, 5), normal('back again', 60)]);
    expect(afterText.limit).toBeUndefined();
    expect(afterText.timeline[0].tone).toBe('limit');
    expect(view([apiError(LIMIT, 5), toolUse(60)]).limit).toBeUndefined();
  });

  it('a non-limit api error does not set it', () => {
    const d = view([apiError('API Error: 500 internal server error', 5)]);
    expect(d.limit).toBeUndefined();
    expect(d.timeline[0].tone).toBeUndefined();
  });

  it('a second limit message after recovery sets it again', () => {
    const d = view([apiError(LIMIT, 5), normal('ok', 10), apiError('Claude AI usage limit reached|1700000000', 20)]);
    expect(d.limit?.at).toBe(T0 + 20_000);
  });

  it('a finished (dead) session shows no limit', () => {
    const st = createState();
    ingestLine(st, apiError(LIMIT, 5));
    expect(derive(st, { now: T0 + 10_000, processAlive: false }).limit).toBeUndefined();
  });

  it('matches the known message variants and builds the label', () => {
    for (const t of [LIMIT, "You've hit your weekly limit · resets Mon", 'Claude AI usage limit reached|123', 'rate limit exceeded', 'Your usage limit will reset at 5pm']) {
      expect(LIMIT_TEXT_RE.test(t), t).toBe(true);
    }
    expect(LIMIT_TEXT_RE.test('API Error: 500')).toBe(false);
    expect(limitLabel(LIMIT)).toBe('ติดลิมิต · resets 1:30pm (Asia/Bangkok)');
    expect(limitLabel('Claude AI usage limit reached')).toBe('ติดลิมิต');
  });
});
