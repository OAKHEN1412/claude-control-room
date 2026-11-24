import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../../shared/protocol';
import { limitOf, limitText } from './limit';
import { formatTimeline } from './terminalLines';

describe('limit helpers', () => {
  const l = { text: "You've hit your 5-hour limit · resets 1:30pm (Asia/Bangkok)", at: 1 };
  it('prefers the session limit, falls back to the runner, else null', () => {
    expect(limitOf({ limit: l }, { limit: { text: 'x', at: 2 } })).toBe(l);
    expect(limitOf({}, { limit: l })).toBe(l);
    expect(limitOf({}, undefined)).toBeNull();
    expect(limitOf(null)).toBeNull();
  });
  it('builds the Thai label with the reset part', () => {
    expect(limitText({ limit: l })).toBe('ติดลิมิต · resets 1:30pm (Asia/Bangkok)');
    expect(limitText({})).toBeNull();
  });
});

describe('limit tone in the terminal log', () => {
  it('keeps the tone on the assistant line only for limit events', () => {
    const events: TimelineEvent[] = [
      { ts: 1, kind: 'text', text: 'hit your 5-hour limit', tone: 'limit' },
      { ts: 2, kind: 'text', text: 'normal' },
    ];
    const lines = formatTimeline(events);
    expect(lines[0]).toMatchObject({ kind: 'assistant', tone: 'limit' });
    expect(lines[1].tone).toBeUndefined();
  });
});
