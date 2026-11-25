// Auto-resume: live Runner jobs are remembered in SQLite, resumed idle at startup; closed jobs never come back; cap 8.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTORESUME_MAX, AutoResume, RESUME_FAIL_MS, resumeMode } from '../src/autoresume';
import { WorklogDb } from '../src/db';
import { Runner, type ChildLike } from '../src/runner';

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 100;
  killed = 0;
  written: string[] = [];
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => {
      if (!d.toString().includes('"initialize"')) this.written.push(d.toString()); // the slash-menu request is not a message
    });
  }
  kill(): boolean {
    this.killed++;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let tmp: string;
let db: WorklogDb;
let children: FakeChild[];
let calls: string[][];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-autoresume-'));
  db = new WorklogDb(':memory:');
  children = [];
  calls = [];
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkRunner(allowed: string[] = [tmp]): Runner {
  return new Runner({
    allowedCwds: () => allowed,
    spawn: (_cmd, args) => {
      const c = new FakeChild();
      children.push(c);
      calls.push(args);
      return c;
    },
  });
}

function mk(over: { now?: () => number; max?: number; allowed?: string[] } = {}) {
  const runner = mkRunner(over.allowed);
  const ar = new AutoResume({ db, runner, now: over.now, max: over.max, titleOf: (id) => `title ${id.slice(-2)}` });
  ar.start();
  return { runner, ar };
}

describe('AutoResume', () => {
  it('remembers a live job with cwd, model, effort, title and mode', () => {
    const { runner } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'hi' });
    const rows = db.listRunnerJobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: id, cwd: tmp, model: 'haiku', effort: 'low', permissionMode: 'default' });
    expect(rows[0].title).toBe(`title ${id.slice(-2)}`);
  });

  it('a closed job is forgotten at once, so it is not resumed after a restart', () => {
    const { runner } = mk();
    const keep = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'a' });
    const closed = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'b' });
    runner.close(closed);
    expect(db.listRunnerJobs().map((r) => r.sessionId)).toEqual([keep]);
    // a new server process
    const second = mk();
    expect(second.ar.restore()).toBe(1);
    expect(calls[calls.length - 1]).toEqual(expect.arrayContaining(['--resume', keep]));
    expect(second.runner.has(closed)).toBe(false);
  });

  it('restore resumes idle: --resume with the stored model/effort/mode, no prompt written', () => {
    const first = mk();
    const id = first.runner.start({ cwd: tmp, model: 'sonnet', effort: 'medium', prompt: 'x', permissionMode: 'acceptEdits' });
    const second = mk({ allowed: [] }); // the whitelist is still empty right after startup
    second.ar.restore();
    const args = calls[calls.length - 1];
    expect(args[args.indexOf('--resume') + 1]).toBe(id);
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).not.toContain('--session-id');
    const child = children[children.length - 1];
    expect(child.written).toEqual([]); // nothing was sent to the child
    expect(second.runner.states()[0]).toMatchObject({ sessionId: id, busy: false, alive: true });
  });

  it('keeps the job own mode, bypassPermissions included', () => {
    expect(resumeMode('bypassPermissions')).toBe('bypassPermissions');
    expect(resumeMode('plan')).toBe('plan');
    expect(resumeMode('weird')).toBe('default');
  });

  it('an entry whose folder is gone is dropped and does not stop the others', () => {
    const gone = path.join(tmp, 'gone');
    fs.mkdirSync(gone);
    const first = mk({ allowed: [tmp, gone] });
    const a = first.runner.start({ cwd: gone, model: 'haiku', effort: 'low', prompt: 'a' });
    const b = first.runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'b' });
    fs.rmSync(gone, { recursive: true });
    const second = mk();
    expect(second.ar.restore()).toBe(1);
    expect(db.listRunnerJobs().map((r) => r.sessionId)).toEqual([b]);
    expect(second.runner.has(a)).toBe(false);
  });

  it('a resumed child that dies at once (no such conversation) is dropped; one that dies much later is not', () => {
    let t = 1_000;
    const first = mk({ now: () => t });
    const id = first.runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'a' });
    const second = mk({ now: () => t });
    second.ar.restore();
    children[children.length - 1].emit('exit', 1, null);
    expect(db.listRunnerJobs().map((r) => r.sessionId)).not.toContain(id);

    const third = mk({ now: () => t });
    t += 10;
    const id2 = third.runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'b' });
    const fourth = mk({ now: () => t });
    fourth.ar.restore();
    t += RESUME_FAIL_MS + 1;
    children[children.length - 1].emit('exit', 0, null);
    expect(db.listRunnerJobs().map((r) => r.sessionId)).toContain(id2);
  });

  it('keeps at most 8 jobs: the oldest are dropped when more are started, and restore resumes only the newest 8', () => {
    let t = 1;
    const { runner } = mk({ now: () => t++ });
    const ids: string[] = [];
    for (let i = 0; i < AUTORESUME_MAX + 3; i++) ids.push(runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: String(i) }));
    const rows = db.listRunnerJobs();
    expect(rows).toHaveLength(AUTORESUME_MAX);
    expect(rows.map((r) => r.sessionId)).not.toContain(ids[0]);
    expect(rows.map((r) => r.sessionId)).toContain(ids[ids.length - 1]);

    // a database that already holds more than the cap (older version, manual edit): restore still honours it
    for (let i = 0; i < 4; i++) db.upsertRunnerJob({ sessionId: ID(i + 1), cwd: tmp, model: 'haiku', effort: 'low', title: '', permissionMode: 'default', updatedAt: 1_000_000 + i });
    const second = mk();
    expect(second.ar.restore()).toBe(AUTORESUME_MAX);
    expect(db.listRunnerJobs()).toHaveLength(AUTORESUME_MAX);
  });

  it('suspend (server shutdown) keeps the rows even though the children die', () => {
    const { runner, ar } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'a' });
    ar.suspend();
    runner.shutdown();
    expect(children[0].killed).toBe(1);
    expect(db.listRunnerJobs().map((r) => r.sessionId)).toEqual([id]);
  });

  it('a job that died on its own and left the Runner is forgotten', () => {
    const { runner } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'a' });
    children[0].emit('exit', 1, null);
    expect(db.listRunnerJobs()).toHaveLength(1); // still listed for a while
    runner.emit('removed', id);
    expect(db.listRunnerJobs()).toHaveLength(0);
  });
});
