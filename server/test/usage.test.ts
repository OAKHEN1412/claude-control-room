import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contextTokensFromUsage,
  contextWindowFor,
  deriveContext,
  formatCountdown,
  formatTokens,
  freshest,
  isStale,
  levelOf,
  mergeSessions,
  parseRateLimitEvent,
  parseTrigger,
  toMs,
  type UsageQuota,
  type UsageSnapshot,
} from '../../shared/usage';
import { UsageService } from '../src/usage';

const MIN = 60_000;
const q = (pct: number, updatedAt: number, extra: Partial<UsageQuota> = {}): UsageQuota => ({ pct, resetsAt: null, updatedAt, sessionId: 's', model: null, ...extra });

describe('levels and formatting', () => {
  it('colour levels: <70 ok, 70-89 warn, >=90 crit', () => {
    expect([0, 69.9, 70, 89.9, 90, 100].map(levelOf)).toEqual(['ok', 'ok', 'warn', 'warn', 'crit', 'crit']);
  });
  it('stale after 10 minutes', () => {
    expect(isStale(1000, 1000 + 10 * MIN)).toBe(false);
    expect(isStale(1000, 1001 + 10 * MIN)).toBe(true);
  });
  it('reset countdown in Thai', () => {
    const now = 1_000_000_000_000;
    expect(formatCountdown(now + 135 * MIN, now)).toBe('อีก 2 ชม. 15 นาที');
    expect(formatCountdown(now + 12 * MIN, now)).toBe('อีก 12 นาที');
    expect(formatCountdown(now + 60 * MIN, now)).toBe('อีก 1 ชม.');
    expect(formatCountdown(now + (2 * 1440 + 3 * 60 + 40) * MIN, now)).toBe('อีก 2 วัน 3 ชม.');
    expect(formatCountdown(now - 1, now)).toBe('รีเซ็ตแล้ว');
    expect(formatCountdown(null, now)).toBeNull();
  });
  it('token counts like the status line', () => {
    expect(formatTokens(319_005)).toBe('319k');
    expect(formatTokens(1_000_000)).toBe('1.0m');
    expect(formatTokens(850)).toBe('850');
  });
  it('seconds or milliseconds become milliseconds', () => {
    expect(toMs(1795408200)).toBe(1795408200000);
    expect(toMs(1795408200000)).toBe(1795408200000);
    expect(toMs(0)).toBeNull();
    expect(toMs('x')).toBeNull();
  });
});

describe('derived context', () => {
  it('sums input + cache creation + cache read', () => {
    expect(contextTokensFromUsage({ input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 318_000, output_tokens: 99 })).toBe(319_005);
    expect(contextTokensFromUsage({ output_tokens: 3 })).toBeNull();
    expect(contextTokensFromUsage(null)).toBeNull();
  });
  it('window: 1M for 5.x models, else 200k; a known window wins', () => {
    expect(contextWindowFor('claude-opus-5-5')).toBe(1_000_000);
    expect(contextWindowFor('Opus 5.5')).toBe(1_000_000);
    expect(contextWindowFor('claude-sonnet-4-5')).toBe(200_000);
    expect(contextWindowFor('claude-sonnet-4-5[1m]')).toBe(1_000_000);
    expect(contextWindowFor(null)).toBe(200_000);
    const d = deriveContext('a', 'claude-opus-5-5', { input_tokens: 100_000 }, 5, 500_000);
    expect(d).toMatchObject({ ctxPct: 20, ctxUsed: 100_000, ctxWindow: 500_000, estimated: true });
    expect(deriveContext('a', null, {}, 5)).toBeNull();
  });
});

describe('parseTrigger', () => {
  it('reads a new-format file', () => {
    const r = parseTrigger(
      { session_id: 'abc', ctx: 32, five_hour: 39, seven_day: 41, updated_at: 5000, model: 'Opus 5.5', five_hour_resets_at: 9_000_000_000_000, seven_day_resets_at: 9_100_000_000_000, ctx_tokens: 319_005, ctx_window: 1_000_000 },
      1,
      'fallback',
    )!;
    expect(r.session).toMatchObject({ sessionId: 'abc', ctxPct: 32, ctxUsed: 319_005, ctxWindow: 1_000_000, estimated: false, updatedAt: 5000, model: 'Opus 5.5' });
    expect(r.fiveHour).toMatchObject({ pct: 39, resetsAt: 9_000_000_000_000, updatedAt: 5000 });
    expect(r.sevenDay).toMatchObject({ pct: 41 });
  });
  it('old file: updated_at from mtime, zero quota with no reset time means "no number"', () => {
    const r = parseTrigger({ session_id: 's', ctx: 0, five_hour: 0, seven_day: 12 }, 777, 'f')!;
    expect(r.session.updatedAt).toBe(777);
    expect(r.session.ctxPct).toBeNull();
    expect(r.fiveHour).toBeNull();
    expect(r.sevenDay).toMatchObject({ pct: 12, resetsAt: null });
  });
  it('a real 0 % with a reset time is kept; session id falls back to the file name', () => {
    const r = parseTrigger({ five_hour: 0, five_hour_resets_at: 1795408200 }, 1, 'from-file')!;
    expect(r.session.sessionId).toBe('from-file');
    expect(r.fiveHour).toMatchObject({ pct: 0, resetsAt: 1795408200000 });
  });
  it('percent only: token count is estimated from the model table', () => {
    const r = parseTrigger({ session_id: 's', ctx: 10, model_id: 'claude-opus-5-5' }, 1, 'f')!;
    expect(r.session).toMatchObject({ ctxPct: 10, ctxWindow: 1_000_000, ctxUsed: 100_000, estimated: true });
  });
  it('garbage gives null, missing fields stay null', () => {
    expect(parseTrigger('x', 1, 'f')).toBeNull();
    expect(parseTrigger(null, 1, 'f')).toBeNull();
    const r = parseTrigger({}, 1, 'f')!;
    expect(r.session.ctxPct).toBeNull();
    expect(r.session.model).toBeNull();
    expect(r.fiveHour).toBeNull();
    expect(r.sevenDay).toBeNull();
  });
});

describe('merging', () => {
  it('freshest quota wins, null side ignored, tie keeps the first', () => {
    expect(freshest(q(10, 1), q(20, 2))!.pct).toBe(20);
    expect(freshest(q(10, 5), q(20, 2))!.pct).toBe(10);
    expect(freshest(null, q(20, 2))!.pct).toBe(20);
    expect(freshest(q(10, 1), null)!.pct).toBe(10);
    expect(freshest(q(10, 3), q(20, 3))!.pct).toBe(10);
    expect(freshest(null, null)).toBeNull();
  });
  it('one entry per session, newest first', () => {
    const mk = (id: string, t: number, pct: number) => ({ sessionId: id, model: null, ctxPct: pct, ctxUsed: null, ctxWindow: null, estimated: false, updatedAt: t });
    expect(mergeSessions([mk('a', 1, 10), mk('b', 5, 20), mk('a', 9, 30)]).map((s) => [s.sessionId, s.ctxPct])).toEqual([['a', 30], ['b', 20]]);
  });
  it('rate_limit_event from the stream: utilization 0..1, epoch seconds', () => {
    const ev = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.67, resetsAt: 1795408200 }, seven_day: { utilization: 0.07, resetsAt: 1795986000 } } } };
    const r = parseRateLimitEvent(ev, 'sid', 42);
    expect(r.fiveHour).toMatchObject({ pct: 67, resetsAt: 1795408200000, updatedAt: 42, sessionId: 'sid' });
    expect(r.sevenDay!.pct).toBeCloseTo(7);
    expect(parseRateLimitEvent({ type: 'rate_limit_event' }, null, 1)).toEqual({ fiveHour: null, sevenDay: null });
  });
});

describe('UsageService', () => {
  let dir: string;
  let t: number;
  const write = (name: string, body: unknown, mtime: number) => {
    const f = path.join(dir, `${name}.trigger.json`);
    fs.writeFileSync(f, JSON.stringify(body));
    fs.utimesSync(f, mtime / 1000, mtime / 1000);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-usage-'));
    t = Date.now();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('newest updated_at wins across sessions; per-session context kept', () => {
    write('a', { session_id: 'a', ctx: 10, five_hour: 30, seven_day: 40, updated_at: t - 5 * MIN, five_hour_resets_at: t + 3_600_000 }, t - 5 * MIN);
    write('b', { session_id: 'b', ctx: 55, five_hour: 35, seven_day: 41, updated_at: t - 1 * MIN, five_hour_resets_at: t + 3_600_000 }, t - 1 * MIN);
    write('c', { session_id: 'c', ctx: 5 }, t - 2 * MIN); // old format: no quota
    const svc = new UsageService({ dir, now: () => t });
    svc.refresh();
    const s = svc.snapshot();
    expect(s.fiveHour).toMatchObject({ pct: 35, sessionId: 'b' });
    expect(s.sevenDay).toMatchObject({ pct: 41 });
    expect(s.sessions.map((x) => x.sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('ignores files older than maxAge, bad JSON, and a missing dir; emits only on change', () => {
    write('old', { session_id: 'old', ctx: 90 }, t - 7 * 3600_000);
    fs.writeFileSync(path.join(dir, 'bad.trigger.json'), '{nope');
    const svc = new UsageService({ dir, now: () => t });
    const seen: UsageSnapshot[] = [];
    svc.on('change', (s: UsageSnapshot) => seen.push(s));
    svc.refresh();
    expect(svc.snapshot().sessions.map((x) => x.sessionId)).toEqual([]);
    svc.refresh();
    expect(seen.length).toBe(0); // nothing usable -> nothing to say
    write('new', { session_id: 'new', ctx: 12, updated_at: t }, t);
    svc.refresh();
    expect(seen.length).toBe(1);
    svc.refresh();
    expect(seen.length).toBe(1);
    expect(new UsageService({ dir: path.join(dir, 'nope'), now: () => t }).snapshot()).toEqual({ fiveHour: null, sevenDay: null, sessions: [] });
  });

  it('stream events: rate limit, window from result, context from the last assistant message', () => {
    const svc = new UsageService({ dir, now: () => t });
    svc.ingest('r1', { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1795408200 } } } });
    svc.ingest('r1', { type: 'assistant', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 90_000 } } });
    svc.ingest('r1', { type: 'assistant', parent_tool_use_id: 'x', message: { usage: { input_tokens: 999_999 } } }); // subagent: ignored
    let s = svc.snapshot();
    expect(s.fiveHour).toMatchObject({ pct: 50, sessionId: 'r1' });
    expect(s.sessions[0]).toMatchObject({ sessionId: 'r1', ctxUsed: 100_002, ctxWindow: 1_000_000, estimated: true });
    svc.ingest('r1', { type: 'result', modelUsage: { 'claude-haiku-5-5': { contextWindow: 200_000 } } });
    svc.ingest('r1', { type: 'assistant', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 50_000 } } });
    s = svc.snapshot();
    expect(s.sessions[0]).toMatchObject({ ctxWindow: 200_000, ctxPct: 25 });
  });

  it('a status-line quota newer than the stream one wins', () => {
    const svc = new UsageService({ dir, now: () => t });
    svc.ingest('r1', { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1795408200 } } } });
    write('a', { session_id: 'a', five_hour: 61, five_hour_resets_at: 1795408200, updated_at: t + 1000 }, t);
    svc.refresh();
    expect(svc.snapshot().fiveHour!.pct).toBe(61);
  });
});
