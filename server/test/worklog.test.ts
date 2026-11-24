import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../../shared/protocol';
import { WorklogDb } from '../src/db';
import type { HaikuFn } from '../src/haiku';
import {
  IDLE_MS,
  PER_HOUR,
  PER_SESSION_MS,
  RateLimiter,
  Worklog,
  buildSummaryPrompt,
  deterministicBullets,
  isFinished,
  parseSummary,
  startOfLocalDay,
  type WorklogSource,
} from '../src/worklog';

const tmp: string[] = [];
const open: WorklogDb[] = [];
function tmpDb(): { db: WorklogDb; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-db-'));
  tmp.push(dir);
  const file = path.join(dir, 'sub', 'control-room.db'); // parent dir is created by the store
  const db = new WorklogDb(file);
  open.push(db);
  return { db, file };
}
afterEach(() => {
  for (const d of open.splice(0)) {
    try {
      d.close();
    } catch {
      // already closed by the test
    }
  }
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime(); // local noon, so "today" is unambiguous
const MIN = 60_000;

function info(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's1',
    pid: 1,
    name: 'job',
    cwd: 'C:\\w\\stage2',
    kind: 'sdk-cli',
    title: 'ทดสอบ error สองครั้ง',
    model: 'claude-haiku-5-5',
    effort: 'low',
    status: 'idle',
    thought: '',
    startedAt: NOW - 30 * MIN,
    lastActivity: NOW - 5 * MIN,
    timeline: [],
    subagents: [],
    ...over,
  };
}
const fail = (id: string, ts: number, tool = 'คำสั่ง: nosuchcmd', text = 'Exit code 127: not found') => ({ id, ts, tool, text });
function source(over: Partial<WorklogSource> = {}, i: Partial<SessionInfo> = {}): WorklogSource {
  return {
    info: info(i),
    failures: [fail('f1', NOW - 20 * MIN), fail('f2', NOW - 19 * MIN, 'อ่านไฟล์: nope.txt', 'File does not exist.')],
    prompts: ['ลองสองอย่างที่พัง'],
    lastText: 'ลองแล้ว พังทั้งคู่',
    turns: 3,
    ...over,
  };
}

describe('isFinished (idle detection)', () => {
  const s = (status: SessionInfo['status'], ago: number) => ({ status, lastActivity: NOW - ago });
  it('idle for 2 min after at least one assistant turn = finished', () => {
    expect(isFinished(s('idle', IDLE_MS), 1, NOW)).toBe(true);
    expect(isFinished(s('idle', IDLE_MS - 1000), 1, NOW)).toBe(false);
  });
  it('needs at least one assistant turn', () => {
    expect(isFinished(s('idle', 10 * MIN), 0, NOW)).toBe(false);
    expect(isFinished(s('done', 0), 0, NOW)).toBe(false);
  });
  it('done (process gone) is finished at once; running / waiting / unreadable never are', () => {
    expect(isFinished(s('done', 0), 2, NOW)).toBe(true);
    for (const st of ['running', 'waiting', 'unreadable'] as const) expect(isFinished(s(st, 60 * MIN), 5, NOW)).toBe(false);
  });
  it('honours a custom idle time', () => {
    expect(isFinished(s('idle', 5000), 1, NOW, 4000)).toBe(true);
  });
});

describe('RateLimiter', () => {
  it('allows one call per session per 10 minutes', () => {
    const r = new RateLimiter();
    expect(r.canRun('a', NOW)).toBe(true);
    r.record('a', NOW);
    expect(r.canRun('a', NOW + PER_SESSION_MS - 1)).toBe(false);
    expect(r.nextAllowed('a', NOW)).toBe(NOW + PER_SESSION_MS);
    expect(r.canRun('a', NOW + PER_SESSION_MS)).toBe(true);
    expect(r.canRun('b', NOW + 1)).toBe(true); // another session is independent
  });
  it('allows at most 20 per hour overall, then frees a slot as the oldest ages out', () => {
    const r = new RateLimiter();
    for (let i = 0; i < PER_HOUR; i++) r.record(`s${i}`, NOW + i * 1000);
    const t = NOW + PER_HOUR * 1000;
    expect(r.canRun('fresh', t)).toBe(false);
    expect(r.nextAllowed('fresh', t)).toBe(NOW + 60 * MIN);
    expect(r.canRun('fresh', NOW + 60 * MIN)).toBe(true);
  });
});

describe('summary text helpers', () => {
  it('groups identical failures and caps the list', () => {
    const b = deterministicBullets([
      { tool: 'คำสั่ง: x', text: 'Exit code 1' },
      { tool: 'คำสั่ง: x', text: 'Exit code 1' },
      { tool: 'อ่านไฟล์: a', text: 'missing' },
    ]);
    expect(b).toEqual(['คำสั่ง: x: Exit code 1 ×2', 'อ่านไฟล์: a: missing']);
    const many = deterministicBullets(Array.from({ length: 12 }, (_, i) => ({ tool: `t${i}`, text: 'e' })));
    expect(many).toHaveLength(6);
    expect(many[5]).toBe('…และอีก 7 รายการ');
  });

  it('parses the reply with or without code fences, and rejects junk', () => {
    expect(parseSummary('{"result":"เสร็จ: ok","bullets":["ก: ข"]}')).toEqual({ result: 'เสร็จ: ok', bullets: ['ก: ข'] });
    expect(parseSummary('```json\n{"result":"เสร็จ: ok","bullets":[]}\n```')).toEqual({ result: 'เสร็จ: ok', bullets: [] });
    expect(parseSummary('no json here')).toBeNull();
    expect(parseSummary('{"result":"","bullets":[]}')).toBeNull();
    expect(parseSummary('{"bullets":["x"]}')).toBeNull();
  });

  it('the summary prompt carries title, prompts, last text and every failure', () => {
    const p = buildSummaryPrompt({ title: 'T', cwd: 'C:\\w', prompts: ['p1', 'p2'], lastText: 'last', failures: [{ tool: 'a', text: 'x' }, { tool: 'b', text: 'y' }] });
    for (const part of ['งาน: T', '- p1', '- p2', 'last', '1. [a] x', '2. [b] y', 'รายการที่ล้มเหลว (2)']) expect(p).toContain(part);
  });
});

describe('WorklogDb', () => {
  it('round-trips failures (deduped by id) and cards through a real file, and survives reopen', () => {
    const { db, file } = tmpDb();
    expect(db.insertFailure({ id: 'f1', sessionId: 's1', ts: 10, tool: 'คำสั่ง: x', text: 'e1' })).toBe(true);
    expect(db.insertFailure({ id: 'f1', sessionId: 's1', ts: 10, tool: 'คำสั่ง: x', text: 'e1' })).toBe(false);
    db.insertFailure({ id: 'f2', sessionId: 's1', ts: 5, tool: 'อ่านไฟล์: y', text: 'e2' });
    expect(db.failuresFor('s1').map((f) => f.id)).toEqual(['f2', 'f1']); // by time
    expect(db.failureCount('s1')).toBe(2);
    db.upsertCard({
      sessionId: 's1', title: 'ชื่อ', cwd: 'C:\\w', finishedAt: 100, activityAt: 100, result: 'เสร็จ: ok', bullets: ['ก', 'ข'],
      failureCount: 2, state: 'haiku', summarizedAt: 50, updatedAt: 60,
    });
    db.upsertCard({
      sessionId: 's1', title: 'ชื่อใหม่', cwd: 'C:\\w', finishedAt: 200, activityAt: 200, result: null, bullets: [],
      failureCount: 2, state: 'queued', summarizedAt: 50, updatedAt: 70,
    });
    db.logCall({ ts: 1000, kind: 'summary', sessionId: 's1', ok: true, ms: 900, costUsd: 0.0002 });
    db.logCall({ ts: 2000, kind: 'ask', ok: false, ms: 10 });
    db.close();

    const db2 = new WorklogDb(file);
    open.push(db2);
    expect(db2.failuresFor('s1')).toHaveLength(2);
    const c = db2.getCard('s1');
    expect(c).toMatchObject({ title: 'ชื่อใหม่', finishedAt: 200, result: null, bullets: [], state: 'queued', summarizedAt: 50 });
    expect(db2.cardsSince(150)).toHaveLength(1);
    expect(db2.cardsSince(300)).toHaveLength(0);
    expect(db2.callsSince(0)).toHaveLength(2);
    expect(db2.callsSince(0, 'summary')).toEqual([{ ts: 1000, kind: 'summary', sessionId: 's1', ok: true }]);
    db2.close();
  });
});

describe('Worklog', () => {
  const okHaiku = (calls: string[]): HaikuFn => async (prompt) => {
    calls.push(prompt);
    return { text: '{"result":"เสร็จ: ลองสองคำสั่ง พังทั้งคู่","bullets":["คำสั่ง nosuchcmd: ไม่พบคำสั่ง","อ่านไฟล์ nope.txt: ไม่มีไฟล์"]}', ms: 800, costUsd: 0.0003 };
  };

  it('records failures once, makes a card when the job is idle, then Haiku words it', async () => {
    const { db } = tmpDb();
    let now = NOW;
    const src = source();
    const calls: string[] = [];
    const wl = new Worklog({ db, sources: () => [src], haiku: okHaiku(calls), now: () => now });
    const changes: number[] = [];
    wl.on('change', (c: unknown[]) => changes.push(c.length));
    await wl.tick();
    await wl.tick(); // second pass must not duplicate anything
    expect(db.failureCount('s1')).toBe(2);
    expect(calls).toHaveLength(1);
    const [card] = wl.cards();
    expect(card).toMatchObject({ sessionId: 's1', state: 'haiku', failureCount: 2, result: 'เสร็จ: ลองสองคำสั่ง พังทั้งคู่' });
    expect(card.bullets).toHaveLength(2);
    expect(changes.length).toBeGreaterThan(0);
    expect(calls[0]).toContain('nosuchcmd');
    expect(db.callsSince(0, 'summary')).toHaveLength(1);
    now += 1;
  });

  it('shows deterministic bullets at once, even before Haiku answers, and keeps them when Haiku fails', async () => {
    const { db } = tmpDb();
    let release: (() => void) | undefined;
    const slow: HaikuFn = () => new Promise((_, reject) => (release = () => reject(new Error('haiku: timed out'))));
    const wl = new Worklog({ db, sources: () => [source()], haiku: slow, now: () => NOW });
    const first = wl.tick();
    await Promise.resolve();
    const queued = wl.cards()[0];
    expect(queued.state).toBe('queued');
    expect(queued.result).toBeNull();
    expect(queued.bullets).toEqual(['คำสั่ง: nosuchcmd: Exit code 127: not found', 'อ่านไฟล์: nope.txt: File does not exist.']);
    release?.();
    await first;
    const failed = wl.cards()[0];
    expect(failed.state).toBe('rule');
    expect(failed.bullets).toEqual(queued.bullets);
    expect(db.callsSince(0, 'summary')[0].ok).toBe(false);
  });

  it('without a model, cards stay deterministic', async () => {
    const { db } = tmpDb();
    const wl = new Worklog({ db, sources: () => [source()], now: () => NOW });
    await wl.tick();
    expect(wl.cards()[0]).toMatchObject({ state: 'rule', result: null, failureCount: 2 });
  });

  it('backfills only today: failures from before local midnight are not recorded', async () => {
    const { db } = tmpDb();
    const old = NOW - 2 * 24 * 60 * MIN;
    const wl = new Worklog({ db, sources: () => [source({ failures: [fail('old', old), fail('new', NOW - 10 * MIN)] })], now: () => NOW });
    await wl.tick();
    expect(db.failuresFor('s1').map((f) => f.id)).toEqual(['new']);
    expect(startOfLocalDay(NOW)).toBeLessThanOrEqual(NOW);
    // a session whose last activity is yesterday gets no card
    const wl2 = new Worklog({ db, sources: () => [source({}, { sessionId: 's2', lastActivity: old })], now: () => NOW });
    await wl2.tick();
    expect(db.getCard('s2')).toBeNull();
  });

  it('makes no card while the job is running, waiting, or only just went quiet', async () => {
    const { db } = tmpDb();
    for (const [status, ago] of [['running', 5 * MIN], ['waiting', 9 * MIN], ['idle', 30_000]] as const) {
      const wl = new Worklog({ db, sources: () => [source({}, { sessionId: `x-${status}`, status, lastActivity: NOW - ago })], now: () => NOW });
      await wl.tick();
      expect(db.getCard(`x-${status}`)).toBeNull();
    }
    expect(db.failureCount('x-running')).toBe(2); // failures are recorded as they happen, the card waits
  });

  it('queues the rest: one summary per session per 10 min, one call at a time', async () => {
    const { db } = tmpDb();
    let now = NOW;
    const calls: string[] = [];
    const a = source({}, { sessionId: 'a' });
    const wl = new Worklog({ db, sources: () => [a, source({}, { sessionId: 'b' })], haiku: okHaiku(calls), now: () => now });
    await wl.tick();
    await wl.tick();
    expect(calls).toHaveLength(2); // a and b once each (one per tick)
    // session a is active again and finishes again 3 minutes later: card is stale, summary must wait
    now += 3 * MIN;
    a.info = info({ sessionId: 'a', lastActivity: now - 2 * MIN });
    a.failures = [...a.failures, fail('f3', now - 3 * MIN)];
    await wl.tick();
    expect(calls).toHaveLength(2);
    expect(wl.pending()).toBe(1);
    expect(wl.cards().find((c) => c.sessionId === 'a')?.state).toBe('queued');
    expect(wl.cards().find((c) => c.sessionId === 'a')?.failureCount).toBe(3);
    now += 8 * MIN; // 11 min after the first summary
    await wl.tick();
    expect(calls).toHaveLength(3);
    expect(wl.pending()).toBe(0);
  });

  it('a restart does not reset the limiter (it is seeded from the DB) and re-queues a stranded card', async () => {
    const { db } = tmpDb();
    const calls: string[] = [];
    const wl1 = new Worklog({ db, sources: () => [source()], haiku: okHaiku(calls), now: () => NOW });
    await wl1.tick();
    expect(calls).toHaveLength(1);
    db.upsertCard({ ...db.getCard('s1')!, state: 'queued' }); // pretend the process died before the next summary landed
    const wl2 = new Worklog({ db, sources: () => [source()], haiku: okHaiku(calls), now: () => NOW + MIN });
    await wl2.tick();
    expect(calls).toHaveLength(1); // 1 min after the last summary of this session: still blocked
    expect(wl2.pending()).toBe(1);
    const wl3 = new Worklog({ db, sources: () => [source()], haiku: okHaiku(calls), now: () => NOW + 11 * MIN });
    await wl3.tick();
    expect(calls).toHaveLength(2);
  });

  it('never gives a session a card that disappears: a Haiku reply with no bullets keeps the failure list', async () => {
    const { db } = tmpDb();
    const empty: HaikuFn = async () => ({ text: '{"result":"เสร็จ: x","bullets":[]}', ms: 1, costUsd: null });
    const wl = new Worklog({ db, sources: () => [source()], haiku: empty, now: () => NOW });
    await wl.tick();
    expect(wl.cards()[0].bullets).toHaveLength(2);
  });
});
