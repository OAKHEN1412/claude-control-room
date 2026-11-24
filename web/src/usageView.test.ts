import { describe, expect, it } from 'vitest';
import type { RunnerState, SessionInfo } from '../../shared/protocol';
import { EMPTY_USAGE, type SessionUsage, type UsageSnapshot } from '../../shared/usage';
import { contextRing, liveSessionIds, pickContext, quotaRing, resetLine } from './usageView';
import { INITIAL_SERVER_STATE, applyMsg, parseMsg } from './useServer';

const MIN = 60_000;
const NOW = new Date(2026, 10, 24, 13, 0, 0).getTime(); // local time, so the clock text is stable in any zone
const su = (id: string, pct: number | null, t: number, extra: Partial<SessionUsage> = {}): SessionUsage => ({ sessionId: id, model: null, ctxPct: pct, ctxUsed: null, ctxWindow: null, estimated: false, updatedAt: t, ...extra });
const sess = (id: string, status: SessionInfo['status']): SessionInfo => ({ sessionId: id, status, title: id, name: id } as SessionInfo);

describe('quotaRing', () => {
  it('colours by level and shows the reset line', () => {
    const q = { pct: 39, resetsAt: NOW + 135 * MIN, updatedAt: NOW - MIN, sessionId: 'abcdef123456', model: 'Opus 5.5' };
    const r = quotaRing('five', q, NOW);
    expect(r).toMatchObject({ level: 'ok', dim: false, text: '39', label: '5 ชม.' });
    expect(r.lines).toContain('รีเซ็ต วันนี้ 15:15 · อีก 2 ชม. 15 นาที');
    expect(r.lines.some((l) => l.includes('Opus 5.5') && l.includes('abcdef12'))).toBe(true);
    expect(quotaRing('week', { ...q, pct: 75 }, NOW).level).toBe('warn');
    expect(quotaRing('week', { ...q, pct: 95 }, NOW).level).toBe('crit');
  });
  it('stale or already-reset windows are dimmed; no data gives an empty ring', () => {
    const old = { pct: 50, resetsAt: NOW + MIN, updatedAt: NOW - 11 * MIN, sessionId: null, model: null };
    const r = quotaRing('five', old, NOW);
    expect(r.dim).toBe(true);
    expect(r.lines.join(' ')).toContain('อัปเดตล่าสุด 11 นาทีที่แล้ว');
    expect(quotaRing('five', { ...old, updatedAt: NOW, resetsAt: NOW - 1 }, NOW).dim).toBe(true);
    expect(quotaRing('five', null, NOW)).toMatchObject({ pct: null, level: 'none', text: '–', dim: true });
  });
  it('weekly reset on another day shows the date', () => {
    expect(resetLine(new Date(2026, 10, 30, 4, 0).getTime(), NOW)).toMatch(/^รีเซ็ต 30 พ\.ย\. 04:00 · อีก 5 วัน/);
    expect(resetLine(null, NOW)).toBeNull();
  });
});

describe('context ring selection', () => {
  const usage: UsageSnapshot = { ...EMPTY_USAGE, sessions: [su('dead', 90, NOW), su('a', 30, NOW - MIN), su('b', 60, NOW - 2 * MIN), su('noctx', null, NOW)] };
  const live = liveSessionIds([sess('a', 'running'), sess('b', 'idle'), sess('noctx', 'idle'), sess('dead', 'done')], {});
  it('follows the selected session, else the most recent live one; ignores finished sessions', () => {
    expect(pickContext(usage, 'b', live).session!.sessionId).toBe('b');
    expect(pickContext(usage, 'zzz', live).session!.sessionId).toBe('a');
    expect(pickContext(usage, null, live).rows.map((r) => r.sessionId)).toEqual(['a', 'b']);
    expect(pickContext(EMPTY_USAGE, null, live).session).toBeNull();
  });
  it('lists at most 8 sessions; a live Runner child counts as live', () => {
    const many: UsageSnapshot = { ...EMPTY_USAGE, sessions: Array.from({ length: 12 }, (_, i) => su(`s${i}`, i, NOW - i)) };
    const all = new Set(many.sessions.map((s) => s.sessionId));
    expect(pickContext(many, null, all).rows).toHaveLength(8);
    expect([...liveSessionIds([], { r: { sessionId: 'r', alive: true } as RunnerState })]).toEqual(['r']);
  });
  it('context ring text and approximate label', () => {
    const r = contextRing(su('a', 32, NOW, { ctxUsed: 319_005, ctxWindow: 1_000_000, model: 'Opus 5.5' }), true, NOW, () => 'งาน A');
    expect(r).toMatchObject({ level: 'ok', text: '32', dim: false });
    expect(r.lines).toContain('319k / 1.0m โทเค็น');
    expect(r.lines.some((l) => l.startsWith('session ที่เลือก: งาน A'))).toBe(true);
    const e = contextRing(su('a', 95, NOW - 20 * MIN, { estimated: true, ctxUsed: 950_000, ctxWindow: 1_000_000 }), false, NOW, () => 'x');
    expect(e).toMatchObject({ level: 'crit', dim: true });
    expect(e.lines.join(' ')).toContain('(ประมาณ)');
    expect(contextRing(null, false, NOW, () => '')).toMatchObject({ pct: null, text: '–' });
  });
});

describe('usage messages in the web state', () => {
  const usage: UsageSnapshot = { fiveHour: null, sevenDay: null, sessions: [su('a', 5, 1)] };
  it('parseMsg accepts a usage message, rejects a malformed one', () => {
    expect(parseMsg(JSON.stringify({ type: 'usage', serverTime: 1, usage }))).not.toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'usage', serverTime: 1 }))).toBeNull();
  });
  it('usage message and snapshot field update state; an old snapshot keeps it', () => {
    let st = applyMsg(INITIAL_SERVER_STATE, { type: 'usage', serverTime: 1, usage }, 5);
    expect(st.usage).toBe(usage);
    st = applyMsg(st, { type: 'snapshot', machine: 'm', serverTime: 2, sessions: [] }, 6);
    expect(st.usage).toBe(usage);
    const next: UsageSnapshot = { ...usage, sessions: [] };
    st = applyMsg(st, { type: 'snapshot', machine: 'm', serverTime: 2, sessions: [], usage: next }, 7);
    expect(st.usage).toBe(next);
  });
});
