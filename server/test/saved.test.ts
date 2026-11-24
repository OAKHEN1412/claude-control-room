// Saved sessions: upsert + throttle, backfill from a temp projects dir, hide/unhide, resume, snapshot/broadcast shape.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SavedSession, ServerMsg, SessionInfo } from '../../shared/protocol';
import { parseClientMsg } from '../src/commands';
import { WorklogDb } from '../src/db';
import { startServer, type RunningServer } from '../src/index';
import { Runner, type ChildLike } from '../src/runner';
import { BACKFILL_CHUNK, SAVED_WRITE_MIN_MS, SavedService, backfillSaved, readTranscriptSummary } from '../src/saved';
import { Watcher } from '../src/watcher';

const DAY = 86_400_000;
const SID = '11111111-aaaa-bbbb-cccc-000000000001';
const SID2 = '11111111-aaaa-bbbb-cccc-000000000002';

let tmp: string;
let projects: string;
let work: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-saved-'));
  projects = path.join(tmp, 'projects');
  work = path.join(tmp, 'work');
  fs.mkdirSync(path.join(projects, 'p1'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function info(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: SID,
    pid: 4242,
    name: 'job',
    cwd: work,
    kind: 'interactive',
    title: 'งานแรก',
    model: 'claude-opus-5-5',
    effort: 'high',
    status: 'idle',
    thought: '',
    startedAt: 1_000,
    lastActivity: 2_000,
    timeline: [],
    subagents: [],
    ...over,
  };
}

function mkService(over: { now?: () => number; alive?: (pid: number) => boolean; snap?: SessionInfo[]; runner?: any; clip?: (id: string) => boolean } = {}) {
  const db = new WorklogDb(':memory:');
  const svc = new SavedService({
    db,
    runner: over.runner,
    snapshot: () => over.snap ?? [],
    pidAlive: over.alive ?? (() => false),
    projectsDir: projects,
    ignoreDirs: [path.join(tmp, 'ignored')],
    isClip: over.clip,
    now: over.now,
  });
  return { db, svc };
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const userLine = (text: string, ts: string, cwd?: string) => line({ type: 'user', timestamp: ts, ...(cwd ? { cwd } : {}), message: { role: 'user', content: text } });
const asstLine = (ts: string, model = 'claude-sonnet-5-5') =>
  line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } });

describe('SavedService upsert + throttle', () => {
  it('upserts a watcher session with source terminal and writes only when a field changed', () => {
    let t = 10_000;
    const { db, svc } = mkService({ now: () => t });
    svc.onSession(info());
    expect(db.getSaved(SID)).toMatchObject({ cwd: work, title: 'งานแรก', model: 'claude-opus-5-5', effort: 'high', source: 'terminal', firstSeen: 1_000, lastActivity: 2_000, hidden: false });
    // identical event: no write (title edited behind the service's back stays)
    db.upsertSaved({ ...db.getSaved(SID)!, title: 'manual' });
    t += 10_000;
    svc.onSession(info());
    expect(db.getSaved(SID)!.title).toBe('manual');
    // changed field after the window: written
    svc.onSession(info({ title: 'ชื่อใหม่' }));
    expect(db.getSaved(SID)!.title).toBe('ชื่อใหม่');
  });

  it('throttles to one write per 5 s per session and flushes the trailing change', () => {
    let t = 10_000;
    const { db, svc } = mkService({ now: () => t });
    svc.onSession(info());
    t += 1_000;
    svc.onSession(info({ title: 'B', lastActivity: 3_000 }));
    expect(db.getSaved(SID)!.title).toBe('งานแรก'); // inside the window
    svc.flush();
    expect(db.getSaved(SID)!.title).toBe('งานแรก'); // still inside
    t += SAVED_WRITE_MIN_MS;
    svc.flush();
    expect(db.getSaved(SID)).toMatchObject({ title: 'B', lastActivity: 3_000 });
    svc.stop();
  });

  it('source: web for a Runner job, clip for a clip job, never downgraded; ignored folders are skipped', () => {
    const { db, svc } = mkService({ runner: { has: (id: string) => id === SID, isAlive: () => false }, clip: (id) => id === SID2 });
    svc.onSession(info());
    svc.onSession(info({ sessionId: SID2 }));
    expect(db.getSaved(SID)!.source).toBe('web');
    expect(db.getSaved(SID2)!.source).toBe('clip');
    const { db: db2, svc: svc2 } = mkService();
    svc2.onSession(info());
    db2.upsertSaved({ ...db2.getSaved(SID)!, source: 'web' });
    svc2.onSession(info({ title: 'again' }));
    expect(db2.getSaved(SID)!.source).toBe('web');
    svc2.onSession(info({ sessionId: SID2, cwd: path.join(tmp, 'ignored', 'summarizer') }));
    expect(db2.getSaved(SID2)).toBeNull();
  });

  it('a hidden session that becomes live again is unhidden automatically', () => {
    const { db, svc } = mkService({ alive: () => true });
    svc.onSession(info());
    svc.setHidden(SID, true);
    expect(db.getSaved(SID)!.hidden).toBe(true);
    svc.onSession(info());
    expect(db.getSaved(SID)!.hidden).toBe(false);
  });
});

describe('list shape', () => {
  it('newest first, hidden included, live from the watcher snapshot or a live Runner job, capped at 300', () => {
    const snap = [info({ pid: 77 })];
    const { db, svc } = mkService({ snap, alive: (pid) => pid === 77, runner: { has: () => false, isAlive: (id: string) => id === SID2 } });
    db.upsertSaved({ sessionId: SID, cwd: work, title: 'a', name: '', model: null, effort: null, source: 'terminal', firstSeen: 1, lastActivity: 100, hidden: false });
    db.upsertSaved({ sessionId: SID2, cwd: work, title: 'b', name: '', model: 'm', effort: 'low', source: 'web', firstSeen: 1, lastActivity: 200, hidden: false });
    db.upsertSaved({ sessionId: 'old', cwd: work, title: 'c', name: '', model: null, effort: null, source: 'terminal', firstSeen: 1, lastActivity: 50, hidden: false });
    svc.setHidden('old', true);
    const l = svc.list();
    expect(l.map((s) => s.sessionId)).toEqual([SID2, SID, 'old']);
    expect(l[0]).toEqual({ sessionId: SID2, cwd: work, title: 'b', model: 'm', effort: 'low', source: 'web', firstSeen: 1, lastActivity: 200, hidden: false, live: true });
    expect(l[1].live).toBe(true);
    expect(l[2]).toMatchObject({ hidden: true, live: false });
    for (let i = 0; i < 305; i++) db.upsertSaved({ sessionId: `bulk-${i}`, cwd: work, title: 't', name: '', model: null, effort: null, source: 'terminal', firstSeen: 1, lastActivity: 1000 + i, hidden: false });
    expect(svc.list()).toHaveLength(300);
  });

  it('emits change only when the list differs', () => {
    const { svc } = mkService();
    const seen: SavedSession[][] = [];
    svc.on('change', (l: SavedSession[]) => seen.push(l));
    svc.onSession(info());
    svc.notifyNow();
    svc.notifyNow();
    expect(seen).toHaveLength(1);
    expect(seen[0][0].sessionId).toBe(SID);
    svc.stop();
  });
});

describe('backfill', () => {
  function writeTranscript(name: string, body: string, ageDays = 1, dir = 'p1'): string {
    const f = path.join(projects, dir, `${name}.jsonl`);
    fs.writeFileSync(f, body);
    const m = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(f, m, m);
    return f;
  }

  it('reads cwd, title, model and last timestamp; skips files without a cwd, old files, and subagent folders', () => {
    const { db } = mkService();
    writeTranscript(
      SID,
      userLine('first prompt here', '2026-11-20T10:00:00.000Z', 'C:\\work\\a') + line({ type: 'ai-title', aiTitle: 'ชื่ออัตโนมัติ' }) + asstLine('2026-11-20T10:05:00.000Z'),
    );
    writeTranscript(SID2, userLine('no cwd anywhere', '2026-11-20T10:00:00.000Z'));
    writeTranscript('old-one', userLine('x', '2026-01-01T00:00:00.000Z', 'C:\\old'), 40);
    fs.mkdirSync(path.join(projects, 'p1', SID, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'p1', SID, 'subagents', 'agent-x.jsonl'), userLine('sub', '2026-11-20T10:00:00.000Z', 'C:\\sub'));
    const n = backfillSaved({ db, projectsDir: projects, ignoreDirs: [] });
    expect(n).toBe(1);
    expect(db.getSaved(SID)).toMatchObject({
      cwd: 'C:\\work\\a',
      title: 'ชื่ออัตโนมัติ',
      model: 'claude-sonnet-5-5',
      source: 'terminal',
      lastActivity: Date.parse('2026-11-20T10:05:00.000Z'),
      hidden: false,
    });
    expect(db.getSaved(SID2)).toBeNull();
    expect(db.getSaved('old-one')).toBeNull();
  });

  it('uses the first human prompt when there is no ai-title, and reads only the first and last 64 KB of a big file', () => {
    const { db } = mkService();
    const filler = line({ type: 'assistant', timestamp: '2026-11-20T10:01:00.000Z', message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'x'.repeat(2000) }] } });
    const body =
      userLine('prompt ที่หนึ่ง', '2026-11-20T10:00:00.000Z', 'C:\\big') +
      filler.repeat(Math.ceil((BACKFILL_CHUNK * 3) / filler.length)) + // far larger than head + tail
      line({ type: 'ai-title', aiTitle: 'ชื่อท้ายไฟล์' }) +
      asstLine('2026-11-21T09:00:00.000Z', 'claude-opus-5-5');
    const f = writeTranscript(SID, body);
    expect(fs.statSync(f).size).toBeGreaterThan(BACKFILL_CHUNK * 2);
    const item = readTranscriptSummary(f, SID, Date.now())!;
    expect(item.cwd).toBe('C:\\big');
    expect(item.title).toBe('ชื่อท้ายไฟล์'); // the title lives only in the tail
    expect(item.model).toBe('claude-opus-5-5');
    expect(item.lastActivity).toBe(Date.parse('2026-11-21T09:00:00.000Z'));
    backfillSaved({ db, projectsDir: projects, ignoreDirs: [] });
    expect(db.getSaved(SID)!.title).toBe('ชื่อท้ายไฟล์');
  });

  it('is idempotent, keeps hidden, and skips the server data folder', () => {
    const { db, svc } = mkService();
    writeTranscript(SID, userLine('hello', '2026-11-20T10:00:00.000Z', 'C:\\a') + asstLine('2026-11-20T10:01:00.000Z'));
    writeTranscript(SID2, userLine('hello', '2026-11-20T10:00:00.000Z', path.join(tmp, 'ignored', 'summarizer')));
    expect(backfillSaved({ db, projectsDir: projects, ignoreDirs: [path.join(tmp, 'ignored')] })).toBe(1);
    svc.setHidden(SID, true);
    expect(backfillSaved({ db, projectsDir: projects, ignoreDirs: [path.join(tmp, 'ignored')] })).toBe(0);
    // the file moved on: refreshed, still hidden
    writeTranscript(SID, userLine('hello', '2026-11-20T10:00:00.000Z', 'C:\\a') + asstLine('2026-11-25T10:01:00.000Z'), 0);
    expect(backfillSaved({ db, projectsDir: projects, ignoreDirs: [path.join(tmp, 'ignored')] })).toBe(1);
    expect(db.getSaved(SID)).toMatchObject({ hidden: true, lastActivity: Date.parse('2026-11-25T10:01:00.000Z') });
    expect(db.getSaved(SID2)).toBeNull();
  });
});

describe('hide / unhide', () => {
  it('only flips the flag: the transcript file is untouched', () => {
    const { db, svc } = mkService();
    const f = path.join(projects, 'p1', `${SID}.jsonl`);
    fs.writeFileSync(f, userLine('x', '2026-11-20T10:00:00.000Z', work));
    const before = fs.statSync(f);
    svc.onSession(info());
    svc.setHidden(SID, true);
    expect(db.getSaved(SID)).toMatchObject({ hidden: true });
    svc.setHidden(SID, false);
    expect(db.getSaved(SID)!.hidden).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.statSync(f).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readdirSync(path.join(projects, 'p1'))).toEqual([`${SID}.jsonl`]);
    expect(() => svc.setHidden('nobody', true)).toThrow('ไม่พบ session');
  });
});

describe('resume', () => {
  class FakeChild extends EventEmitter implements ChildLike {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 999;
    kill(): boolean {
      queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
      return true;
    }
  }
  function mkRunner() {
    const calls: { args: string[]; cwd: string }[] = [];
    const runner = new Runner({
      allowedCwds: () => [], // nothing whitelisted: only trustedCwd gets through
      spawn: (_cmd, args, o) => {
        calls.push({ args, cwd: o.cwd });
        return new FakeChild();
      },
    });
    return { runner, calls };
  }
  function seed(db: WorklogDb, over: Record<string, unknown> = {}) {
    db.upsertSaved({ sessionId: SID, cwd: work, title: 't', name: '', model: 'claude-opus-5-5', effort: 'medium', source: 'terminal', firstSeen: 1, lastActivity: 2, hidden: true, ...over } as any);
  }

  it('refuses a session still open in a terminal', () => {
    const { runner } = mkRunner();
    const { db, svc } = mkService({ runner, snap: [info({ pid: 55 })], alive: (p) => p === 55 });
    seed(db);
    fs.writeFileSync(path.join(projects, 'p1', `${SID}.jsonl`), '{}\n');
    expect(() => svc.resume({ sessionId: SID })).toThrow('session นี้ยังเปิดอยู่ใน terminal');
  });

  it('refuses a job already live under the Runner', () => {
    const { runner } = mkRunner();
    const { db, svc } = mkService({ runner });
    seed(db);
    fs.writeFileSync(path.join(projects, 'p1', `${SID}.jsonl`), '{}\n');
    svc.resume({ sessionId: SID });
    expect(() => svc.resume({ sessionId: SID })).toThrow('งานนี้เปิดอยู่แล้ว');
  });

  it('refuses a missing transcript file and a missing folder; unknown ids', () => {
    const { runner, calls } = mkRunner();
    const { db, svc } = mkService({ runner });
    seed(db);
    expect(() => svc.resume({ sessionId: SID })).toThrow('ไม่พบไฟล์ transcript');
    fs.writeFileSync(path.join(projects, 'p1', `${SID}.jsonl`), '{}\n');
    seed(db, { cwd: path.join(tmp, 'gone') });
    expect(() => svc.resume({ sessionId: SID })).toThrow('ไม่พบโฟลเดอร์');
    expect(() => svc.resume({ sessionId: SID2 })).toThrow('ไม่พบ session');
    expect(calls).toHaveLength(0);
  });

  it('success: --resume <id> in the stored cwd (outside the whitelist), stored model/effort, mode passed, unhidden, never touches the file', () => {
    const { runner, calls } = mkRunner();
    const { db, svc } = mkService({ runner });
    seed(db);
    const f = path.join(projects, 'p1', `${SID}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    svc.resume({ sessionId: SID, permissionMode: 'acceptEdits' });
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(work);
    const a = calls[0].args;
    expect(a[a.indexOf('--resume') + 1]).toBe(SID);
    expect(a[a.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(runner.isAlive(SID)).toBe(true);
    expect(db.getSaved(SID)!.hidden).toBe(false);
    expect(fs.readFileSync(f, 'utf8')).toBe('{}\n');
    // an explicit model id from the browser wins over the stored one
    const r2 = mkRunner();
    const m2 = mkService({ runner: r2.runner });
    seed(m2.db);
    m2.svc.resume({ sessionId: SID, model: 'haiku' });
    expect(r2.calls[0].args[r2.calls[0].args.indexOf('--model') + 1]).toBe('haiku');
  });
});

describe('commands.ts parsing', () => {
  it('saved_hide / saved_unhide / saved_resume', () => {
    expect(parseClientMsg({ type: 'saved_hide', reqId: 'r', sessionId: SID })).toEqual({ ok: true, msg: { type: 'saved_hide', reqId: 'r', sessionId: SID } });
    expect(parseClientMsg({ type: 'saved_unhide', reqId: 'r', sessionId: SID })).toEqual({ ok: true, msg: { type: 'saved_unhide', reqId: 'r', sessionId: SID } });
    expect(parseClientMsg({ type: 'saved_hide', reqId: 'r', sessionId: '../x' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'saved_hide', reqId: 'r' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'saved_resume', reqId: 'r', sessionId: SID })).toEqual({ ok: true, msg: { type: 'saved_resume', reqId: 'r', sessionId: SID } });
    expect(parseClientMsg({ type: 'saved_resume', reqId: 'r', sessionId: SID, model: 'haiku', effort: 'low', permissionMode: 'plan' })).toEqual({
      ok: true,
      msg: { type: 'saved_resume', reqId: 'r', sessionId: SID, model: 'haiku', effort: 'low', permissionMode: 'plan' },
    });
    expect(parseClientMsg({ type: 'saved_resume', reqId: 'r', sessionId: SID, permissionMode: 'bypassPermissions' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'saved_resume', reqId: 'r', sessionId: SID, permissionMode: 'bypassPermissions', confirm: true })).toMatchObject({
      ok: true,
      msg: { permissionMode: 'bypassPermissions', confirm: true },
    });
    expect(parseClientMsg({ type: 'saved_resume', reqId: 'r', sessionId: SID, model: 'qwen' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'saved_resume', reqId: 'r', sessionId: SID, effort: 'nope' }).ok).toBe(false);
  });
});

describe('server: snapshot + broadcast + commands', () => {
  let server: RunningServer | null = null;
  let watcher: Watcher | null = null;
  let svc: SavedService | null = null;
  afterEach(async () => {
    svc?.stop();
    await server?.close();
    watcher?.stop();
    server = null;
  });

  async function boot() {
    const claude = path.join(tmp, 'claude');
    fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
    watcher = new Watcher({ claudeDir: claude, pollMs: 50 });
    const db = new WorklogDb(':memory:');
    db.upsertSaved({ sessionId: SID, cwd: work, title: 'เก่า', name: '', model: null, effort: null, source: 'terminal', firstSeen: 1, lastActivity: 5, hidden: false });
    svc = new SavedService({ db, snapshot: () => watcher!.snapshot(), pidAlive: () => false, projectsDir: path.join(claude, 'projects') });
    server = await startServer({ watcher, port: 0, saved: svc, log: () => {} });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const msgs: ServerMsg[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on('open', () => r()));
    return { ws, msgs };
  }
  const wait = async (cond: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('snapshot carries saved[]; hide/unhide work without a runner and broadcast a debounced saved message', async () => {
    const { ws, msgs } = await boot();
    await wait(() => msgs.some((m) => m.type === 'snapshot'));
    const snap = msgs.find((m) => m.type === 'snapshot') as Extract<ServerMsg, { type: 'snapshot' }>;
    expect(snap.saved).toEqual([{ sessionId: SID, cwd: work, title: 'เก่า', model: null, effort: null, source: 'terminal', firstSeen: 1, lastActivity: 5, hidden: false, live: false }]);
    ws.send(JSON.stringify({ type: 'saved_hide', reqId: 'h1', sessionId: SID }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 'h1'));
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 'h1')).toMatchObject({ ok: true, sessionId: SID });
    await wait(() => msgs.some((m) => m.type === 'saved'), 4000);
    const saved = msgs.find((m) => m.type === 'saved') as Extract<ServerMsg, { type: 'saved' }>;
    expect(saved.sessions[0]).toMatchObject({ sessionId: SID, hidden: true });
    expect(typeof saved.serverTime).toBe('number');
    ws.send(JSON.stringify({ type: 'saved_resume', reqId: 'x1', sessionId: SID }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 'x1'));
    expect((msgs.find((m) => m.type === 'ack' && m.reqId === 'x1') as any).ok).toBe(false); // no runner
    ws.close();
  });
});
