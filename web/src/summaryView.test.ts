import { describe, expect, it } from 'vitest';
import type { WorklogCard } from '../../shared/protocol';
import { applyMsg, INITIAL_SERVER_STATE, parseMsg } from './useServer';
import { cardTime, cardView } from './summaryView';

const card = (over: Partial<WorklogCard> = {}): WorklogCard => ({
  sessionId: 's', title: 't', cwd: 'C:\\w', finishedAt: new Date(2026, 10, 23, 8, 31).getTime(), result: null, bullets: [],
  failureCount: 0, state: 'queued', updatedAt: 0, ...over,
});

describe('summary widget helpers', () => {
  it('formats the card time like the mockup', () => {
    expect(cardTime(new Date(2026, 10, 23, 8, 31).getTime())).toBe('23 พ.ย. 08:31');
  });

  it('shows Haiku\'s line when present, else a plain line that says why', () => {
    expect(cardView(card({ result: 'เสร็จ: ok', state: 'haiku' })).resultText).toBe('เสร็จ: ok');
    expect(cardView(card({ failureCount: 2 })).resultText).toBe('กำลังรอสรุป · ล้มเหลว 2 ครั้ง');
    const rule = cardView(card({ state: 'rule', failureCount: 2, bullets: ['a'] }));
    expect(rule.resultText).toContain('สรุปด้วย Haiku ไม่ได้');
    expect(rule.bullets).toEqual(['a']);
    expect(cardView(card({ state: 'haiku', result: 'x' })).noFailures).toBe(true);
  });

  it('the worklog message updates state and the ack carries the answer', () => {
    const cards = [card({ sessionId: 'a' })];
    const raw = JSON.stringify({ type: 'worklog', serverTime: 1, cards });
    const msg = parseMsg(raw);
    expect(msg).not.toBeNull();
    expect(applyMsg(INITIAL_SERVER_STATE, msg!, 5).worklog).toEqual(cards);
    expect(parseMsg('{"type":"worklog","cards":"x"}')).toBeNull();
    expect(parseMsg('{"type":"ack","reqId":"r","ok":true,"answer":"hi"}')).not.toBeNull();
  });
});
