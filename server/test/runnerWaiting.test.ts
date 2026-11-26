// Runner waiting-for-unlock: a resume (adopt) of a job whose profile is locked keeps the request and spawns nothing
// until resumeWaiting(accountId) is called after the unlock. Fakes only: no real claude, no pty.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountPort } from '../src/accountPort';
import { CommandError, Runner, type ChildLike } from '../src/runner';

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 5151;
  killedWith: unknown[] = [];
  constructor() {
    super();
    this.stdin.on('data', () => {});
    this.stdin.on('finish', () => setTimeout(() => this.emit('exit', 0, null), 5));
  }
  kill(sig?: NodeJS.Signals | number): boolean {
    this.killedWith.push(sig ?? 'default');
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 5);
    return true;
  }
}

const TOKEN_WORK = 'sk-ant-oat01-' + 'W'.repeat(80);
const TOKEN_HOME = 'sk-ant-oat01-' + 'H'.repeat(80);
const SID = '11111111-aaaa';
const SID2 = '22222222-bbbb';

/** Fake port: 'work' and 'home' have tokens; `locked` = password set and not unlocked; `failing` = token gone on unlock. */
class FakePort implements AccountPort {
  readonly locked = new Set<string>(['work', 'home']);
  readonly failing = new Set<string>();
  private readonly tokens = new Map<string, string>([
    ['work', TOKEN_WORK],
    ['home', TOKEN_HOME],
  ]);
  private readonly remembered = new Map<string, string>();
  defaultId(): string {
    return 'work';
  }
  exists(id: string): boolean {
    return this.tokens.has(id);
  }
  nameOf(id: string): string {
    return id;
  }
  isLocked(id: string): boolean {
    return this.locked.has(id);
  }
  tokenFor(id: string): string | null {
    if (this.locked.has(id)) throw new CommandError('account is locked', 'srv.account.locked');
    if (this.failing.has(id)) throw new CommandError('account token not loaded', 'srv.account.noToken');
    return this.tokens.get(id) ?? null;
  }
  sessionAccount(sessionId: string): string | null {
    return this.remembered.get(sessionId) ?? null;
  }
  rememberSession(sessionId: string, accountId: string): void {
    this.remembered.set(sessionId, accountId);
  }
}

describe('Runner waiting for an unlock', () => {
  let tmp: string;
  let port: FakePort;
  let spawned: { args: string[]; env: NodeJS.ProcessEnv }[];
  let events: { name: string; payload: unknown }[];
  let runner: Runner;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-runner-wait-'));
    port = new FakePort();
    spawned = [];
    events = [];
    runner = new Runner({
      allowedCwds: () => [tmp],
      controlTimeoutMs: 50,
      spawn: (_cmd, args, o) => {
        spawned.push({ args, env: o.env });
        return new FakeChild();
      },
      accounts: port,
    });
    runner.on('change', (s) => events.push({ name: 'change', payload: s }));
    runner.on('removed', (sid, extra) => events.push({ name: 'removed', payload: { sid, extra } }));
    runner.on('closing', (sid) => events.push({ name: 'closing', payload: sid }));
    runner.on('waiting_failed', (e) => events.push({ name: 'waiting_failed', payload: e }));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adopt to a locked profile spawns nothing, returns the id, and shows a waiting state', () => {
    const id = runner.adopt({ sessionId: SID, cwd: tmp, accountId: 'work', model: 'haiku', effort: 'low' });
    expect(id).toBe(SID);
    expect(spawned).toHaveLength(0);
    expect(runner.has(SID)).toBe(true);
    expect(runner.isAlive(SID)).toBe(false);
    expect(runner.states()).toHaveLength(1);
    expect(runner.states()[0]).toMatchObject({
      sessionId: SID,
      cwd: tmp,
      alive: false,
      pid: null,
      busy: false,
      queued: 0,
      waitingUnlock: 'work',
      accountId: 'work',
      model: 'haiku',
    });
    expect(runner.states()[0].startedAt).toBeTypeOf('number');
    const change = events.find((e) => e.name === 'change');
    expect(change?.payload).toMatchObject({ sessionId: SID, waitingUnlock: 'work' });
  });

  it('resumeWaiting before the unlock launches nothing and keeps the entry', () => {
    runner.adopt({ sessionId: SID, cwd: tmp, accountId: 'work' });
    expect(runner.resumeWaiting('work')).toBe(0);
    expect(spawned).toHaveLength(0);
    expect(runner.has(SID)).toBe(true);
  });

  it('resumeWaiting after the unlock spawns --resume with the token env, returns 1 and the entry is gone', () => {
    runner.adopt({ sessionId: SID, cwd: tmp, accountId: 'work' });
    port.locked.delete('work');
    expect(runner.resumeWaiting('work')).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(expect.arrayContaining(['--resume', SID]));
    expect(spawned[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_WORK);
    expect(runner.isAlive(SID)).toBe(true);
    // the real session replaces the synthetic state: one entry, no waitingUnlock
    const states = runner.states();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ sessionId: SID, alive: true });
    expect(states[0].waitingUnlock).toBeUndefined();
    // nothing waits any more
    expect(runner.resumeWaiting('work')).toBe(0);
  });

  it('start to a locked profile throws srv.account.locked (adopt is the only path that waits)', () => {
    let caught: unknown;
    try {
      runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x', accountId: 'work' });
    } catch (e) {
      caught = e;
    }
    expect((caught as { srvCode?: string })?.srvCode).toBe('srv.account.locked');
    expect(spawned).toHaveLength(0);
    expect(runner.states()).toEqual([]);
  });

  it('close on a waiting job removes it at once, without a child', () => {
    runner.adopt({ sessionId: SID, cwd: tmp, accountId: 'work' });
    runner.close(SID);
    expect(runner.has(SID)).toBe(false);
    expect(runner.states()).toEqual([]);
    expect(spawned).toHaveLength(0);
    expect(events).toContainEqual({ name: 'closing', payload: SID });
    expect(events).toContainEqual({ name: 'removed', payload: { sid: SID, extra: { closed: true } } });
    // a later unlock finds nothing to launch
    port.locked.delete('work');
    expect(runner.resumeWaiting('work')).toBe(0);
  });

  it('two waiting jobs of two accounts resume independently', () => {
    runner.adopt({ sessionId: SID, cwd: tmp, accountId: 'work' });
    runner.adopt({ sessionId: SID2, cwd: tmp, accountId: 'home' });
    expect(runner.states().map((s) => s.waitingUnlock).sort()).toEqual(['home', 'work']);

    port.locked.delete('work');
    expect(runner.resumeWaiting('work')).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(expect.arrayContaining(['--resume', SID]));
    expect(runner.has(SID2)).toBe(true);
    expect(runner.states().find((s) => s.sessionId === SID2)?.waitingUnlock).toBe('home');

    port.locked.delete('home');
    expect(runner.resumeWaiting('home')).toBe(1);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).toEqual(expect.arrayContaining(['--resume', SID2]));
    expect(spawned[1].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_HOME);
  });

  it('a waiting job whose relaunch fails is reported as waiting_failed, removed, and does not throw', () => {
    runner.adopt({ sessionId: SID, cwd: tmp, accountId: 'home' });
    port.locked.delete('home');
    port.failing.add('home'); // the token is gone after the unlock
    let n: number | undefined;
    expect(() => {
      n = runner.resumeWaiting('home');
    }).not.toThrow();
    expect(n).toBe(0);
    expect(spawned).toHaveLength(0);
    const failed = events.find((e) => e.name === 'waiting_failed');
    expect(failed?.payload).toMatchObject({ sessionId: SID });
    expect(typeof (failed?.payload as { error: unknown }).error).toBe('string');
    expect(runner.has(SID)).toBe(false);
    expect(events).toContainEqual({ name: 'removed', payload: { sid: SID, extra: undefined } });
  });

  it('no token value appears in the waiting state or in the events', () => {
    runner.adopt({ sessionId: SID, cwd: tmp, accountId: 'work' });
    const everything = JSON.stringify({ states: runner.states(), events: events.map((e) => e.payload) });
    expect(everything).not.toContain(TOKEN_WORK);
    expect(everything).not.toContain(TOKEN_HOME);
  });
});
