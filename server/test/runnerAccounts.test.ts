import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerState } from '../../shared/protocol';
import type { AccountPort } from '../src/accountPort';
import { CommandError, Runner, type ChildLike } from '../src/runner';

// Fake child: stdin ending (Runner close) makes it exit on its own, like `claude` does.
class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killedWith: unknown[] = [];
  written: Record<string, any>[] = [];
  private buf = '';
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.written.push(JSON.parse(this.buf.slice(0, i)));
        this.buf = this.buf.slice(i + 1);
      }
    });
    this.stdin.on('finish', () => setTimeout(() => this.emit('exit', 0, null), 5));
  }
  kill(sig?: NodeJS.Signals | number): boolean {
    this.killedWith.push(sig ?? 'default');
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 5);
    return true;
  }
  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
}

/** A child that ignores stdin end: only kill() ends it (exercises the hard-timeout path). */
class StubbornChild extends FakeChild {
  constructor() {
    super();
    this.stdin.removeAllListeners('finish');
  }
}

const TOKEN_A = 'sk-ant-oat01-' + 'A'.repeat(80);
const TOKEN_B = 'sk-ant-oat01-' + 'B'.repeat(80);
const ALL_TOKENS = [TOKEN_A, TOKEN_B];

interface FakeProfile {
  name: string;
  token: string | null | 'missing';
}

/** Fake AccountPort: 'work' (token A), 'home' (token B), 'terminal' (no token), 'broken' (token not loaded). */
class FakePort implements AccountPort {
  readonly remembered = new Map<string, string>();
  readonly rememberCalls: [string, string][] = [];
  /** Profiles with a password that are not unlocked in this run (toggle to simulate the unlock). */
  readonly locked = new Set<string>();
  private readonly profiles = new Map<string, FakeProfile>([
    ['work', { name: 'Work', token: TOKEN_A }],
    ['home', { name: 'Home', token: TOKEN_B }],
    ['terminal', { name: 'Terminal login', token: null }],
    ['broken', { name: 'Broken', token: 'missing' }],
  ]);
  constructor(private fallback = 'work') {}
  defaultId(): string {
    return this.fallback;
  }
  exists(id: string): boolean {
    return this.profiles.has(id);
  }
  nameOf(id: string): string {
    return this.profiles.get(id)?.name ?? id;
  }
  isLocked(id: string): boolean {
    return this.locked.has(id);
  }
  tokenFor(id: string): string | null {
    const p = this.profiles.get(id);
    if (this.locked.has(id)) throw new CommandError('account is locked', 'srv.account.locked');
    if (!p || p.token === 'missing') throw new CommandError('account token not loaded', 'srv.account.noToken');
    return p.token;
  }
  sessionAccount(sessionId: string): string | null {
    return this.remembered.get(sessionId) ?? null;
  }
  rememberSession(sessionId: string, accountId: string): void {
    this.rememberCalls.push([sessionId, accountId]);
    this.remembered.set(sessionId, accountId);
  }
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timed out');
    await tick(5);
  }
}

/** Ends the running turn the way claude does: replay of the consumed message, then the result. */
function finishTurn(child: FakeChild): void {
  child.emitLine({ type: 'user', message: { role: 'user', content: 'x' }, isReplay: true });
  child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
}

/** Error code of a thrown value (or undefined). */
function codeOfError(e: unknown): string | undefined {
  return (e as { srvCode?: string })?.srvCode;
}

describe('Runner with accounts', () => {
  let tmp: string;
  let children: FakeChild[];
  let calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
  let port: FakePort;
  let events: { name: string; payload: unknown }[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-runner-acct-'));
    children = [];
    calls = [];
    port = new FakePort();
    events = [];
    // childEnv() copies process.env: these parent values must be visible to the child only when no token is injected
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api-PARENT-KEY');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'parent-auth-token');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'parent-oauth-token');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkRunner = (extra: Record<string, unknown> = {}, childFactory: () => FakeChild = () => new FakeChild()) => {
    const r = new Runner({
      allowedCwds: () => [tmp],
      controlTimeoutMs: 50,
      spawn: (cmd, args, o) => {
        const c = childFactory();
        children.push(c);
        calls.push({ cmd, args, cwd: o.cwd, env: o.env });
        return c;
      },
      accounts: port,
      ...extra,
    });
    return r;
  };

  const startReq = (accountId?: string) => ({ cwd: tmp, model: 'haiku', effort: 'high' as const, prompt: 'hello', accountId });

  it('(a) without an account port the child env has no injected token and the parent API key is kept', () => {
    const r = new Runner({
      allowedCwds: () => [tmp],
      spawn: (cmd, args, o) => {
        const c = new FakeChild();
        children.push(c);
        calls.push({ cmd, args, cwd: o.cwd, env: o.env });
        return c;
      },
    });
    r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'hi' });
    expect(calls[0].env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(calls[0].env.ANTHROPIC_API_KEY).toBe('sk-ant-api-PARENT-KEY');
    expect(calls[0].env.ANTHROPIC_AUTH_TOKEN).toBe('parent-auth-token');
    expect(r.states()[0]).not.toHaveProperty('accountId');
  });

  it('(b) start as an account with a token: the child gets CLAUDE_CODE_OAUTH_TOKEN, the other logins are removed, the token is in no argv, state is labelled, the session is remembered', () => {
    const r = mkRunner();
    const id = r.start(startReq('work'));
    const env = calls[0].env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A);
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(JSON.stringify(calls[0].args)).not.toContain(TOKEN_A);
    expect(r.states()[0]).toMatchObject({ sessionId: id, accountId: 'work' });
    expect(port.rememberCalls).toEqual([[id, 'work']]);
  });

  it('(c) the terminal profile (no token) leaves the env untouched and is still labelled', () => {
    const r = mkRunner();
    const id = r.start(startReq('terminal'));
    expect(calls[0].env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(calls[0].env.ANTHROPIC_API_KEY).toBe('sk-ant-api-PARENT-KEY');
    expect(calls[0].env.ANTHROPIC_AUTH_TOKEN).toBe('parent-auth-token');
    expect(r.states()[0]).toMatchObject({ sessionId: id, accountId: 'terminal' });
  });

  it('(d) adopt without accountId uses the remembered profile; an unknown remembered id falls back to the default', () => {
    const r = mkRunner();
    const sid = '11111111-aaaa';
    port.remembered.set(sid, 'home');
    r.adopt({ sessionId: sid, cwd: tmp });
    expect(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_B);
    expect(calls[0].args).toContain('--resume');
    expect(r.states()[0]).toMatchObject({ sessionId: sid, accountId: 'home' });

    const sid2 = '22222222-bbbb';
    port.remembered.set(sid2, 'gone-profile'); // not in the port any more
    r.adopt({ sessionId: sid2, cwd: tmp });
    expect(calls[1].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_A); // default = 'work'
    expect(r.states()[1]).toMatchObject({ sessionId: sid2, accountId: 'work' });
    expect(port.remembered.get(sid2)).toBe('work');
  });

  it('(e) a profile whose token is not loaded refuses the start before any child exists and registers nothing', () => {
    const r = mkRunner();
    let thrown: unknown;
    try {
      r.start(startReq('broken'));
    } catch (e) {
      thrown = e;
    }
    expect(codeOfError(thrown)).toBe('srv.account.noToken');
    expect(calls).toHaveLength(0);
    expect(children).toHaveLength(0);
    expect(r.states()).toHaveLength(0);
    expect(port.rememberCalls).toHaveLength(0);
  });

  it('(f) switching an idle job: the old child is closed, the job resumes with --resume under the new token, same folder/model/effort/permission, log and event recorded', async () => {
    const r = mkRunner();
    const seen: unknown[] = [];
    r.on('account_switch', (e) => seen.push(e));
    const id = r.start({ ...startReq('work'), permissionMode: 'plan' });
    finishTurn(children[0]);
    await until(() => r.states()[0].busy === false && r.states()[0].queued === 0);

    expect(await r.setAccount(id, 'home')).toBe('done');

    expect(children).toHaveLength(2);
    expect(children[0].stdin.writableEnded).toBe(true);
    const a = calls[1].args;
    expect(a[a.indexOf('--resume') + 1]).toBe(id);
    expect(a).not.toContain('--session-id');
    expect(calls[1].cwd).toBe(tmp);
    expect(a[a.indexOf('--model') + 1]).toBe('haiku');
    expect(a[a.indexOf('--effort') + 1]).toBe('high');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(calls[1].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_B);
    expect(calls[1].env).not.toHaveProperty('ANTHROPIC_API_KEY');

    const st = r.states().find((s) => s.sessionId === id) as RunnerState;
    expect(st.accountId).toBe('home');
    expect(st.accountPending).toBeUndefined();
    expect(st.accountLog).toHaveLength(1);
    expect(st.accountLog?.[0]).toEqual({ at: expect.any(Number), from: 'Work', to: 'Home' });
    expect(st.permissionMode).toBe('plan');
    expect(r.accountOf(id)).toBe('home');
    expect(port.remembered.get(id)).toBe('home');

    expect(seen).toEqual([{ sessionId: id, from: 'Work', to: 'Home', at: expect.any(Number) }]);
  });

  it('(f2) a child that ignores stdin end is killed after the grace time and the switch still completes', async () => {
    const r = mkRunner({}, () => new StubbornChild());
    const id = r.start(startReq('work'));
    finishTurn(children[0]);
    await until(() => r.states()[0].busy === false && r.states()[0].queued === 0);
    expect(await r.setAccount(id, 'home')).toBe('done');
    // the stubborn child only ends by kill(): close()'s own grace timer (2 s) kills it before the switch's 4 s wait runs out
    expect(children[0].killedWith.length).toBeGreaterThan(0);
    expect(children).toHaveLength(2);
  }, 15_000);

  it('(g) a switch requested while a turn runs is queued, then runs once the turn ends', async () => {
    const r = mkRunner();
    const id = r.start(startReq('work')); // the first message makes the job busy
    expect(r.states()[0]).toMatchObject({ busy: true });

    expect(await r.setAccount(id, 'home')).toBe('queued');
    expect(r.states()[0].accountPending).toBe('home');
    expect(children).toHaveLength(1);
    expect(children[0].stdin.writableEnded).toBe(false);

    finishTurn(children[0]);
    await until(() => children.length === 2);
    expect(calls[1].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_B);
    expect(calls[1].args[calls[1].args.indexOf('--resume') + 1]).toBe(id);
    const st = r.states().find((s) => s.sessionId === id) as RunnerState;
    expect(st.accountPending).toBeUndefined();
    expect(st.accountId).toBe('home');
    expect(st.accountLog?.[0]).toMatchObject({ from: 'Work', to: 'Home' });
  });

  it('(g2) the latest queued request wins; a queued switch is dropped when the job ends before its turn', async () => {
    const r = mkRunner();
    const id = r.start(startReq('work'));
    expect(await r.setAccount(id, 'terminal')).toBe('queued');
    expect(await r.setAccount(id, 'home')).toBe('queued');
    expect(r.states()[0].accountPending).toBe('home');
    children[0].emit('exit', 1, null); // the job dies mid-turn
    await tick(20);
    expect(children).toHaveLength(1);
    expect(port.rememberCalls.filter(([sid]) => sid === id)).toHaveLength(1);
  });

  it('(h) switching to the profile the job already runs as is a no-op', async () => {
    const r = mkRunner();
    const id = r.start(startReq('work'));
    finishTurn(children[0]);
    await until(() => r.states()[0].busy === false && r.states()[0].queued === 0);
    expect(await r.setAccount(id, 'work')).toBe('done');
    expect(children).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(children[0].stdin.writableEnded).toBe(false);
  });

  it('(i) an unknown profile or one without a token is refused before the child is touched', async () => {
    const r = mkRunner();
    const id = r.start(startReq('work'));
    finishTurn(children[0]);
    await until(() => r.states()[0].busy === false && r.states()[0].queued === 0);

    const unknown = await r.setAccount(id, 'nope').then(
      () => null,
      (e: unknown) => e,
    );
    expect(codeOfError(unknown)).toBe('srv.account.unknown');

    const broken = await r.setAccount(id, 'broken').then(
      () => null,
      (e: unknown) => e,
    );
    expect(codeOfError(broken)).toBe('srv.account.noToken');

    expect(children).toHaveLength(1);
    expect(children[0].stdin.writableEnded).toBe(false);
    expect(children[0].killedWith).toHaveLength(0);
    expect(r.states()[0]).toMatchObject({ alive: true, accountId: 'work' });
  });

  it('(i2) setAccount without an account port is refused; a second switch while one runs is refused', async () => {
    const plain = new Runner({ allowedCwds: () => [tmp], spawn: () => new FakeChild() });
    const pid = plain.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'x' });
    await expect(plain.setAccount(pid, 'home')).rejects.toThrow('accounts are not enabled');

    const r = mkRunner();
    const id = r.start(startReq('work'));
    finishTurn(children[0]);
    await until(() => r.states()[0].busy === false && r.states()[0].queued === 0);
    const first = r.setAccount(id, 'home');
    await expect(r.setAccount(id, 'terminal')).rejects.toThrow('already running');
    expect(await first).toBe('done');
  });

  it('(k) start as a locked profile throws srv.account.locked and spawns nothing', () => {
    const r = mkRunner();
    port.locked.add('work');
    let caught: unknown;
    try {
      r.start(startReq('work'));
    } catch (e) {
      caught = e;
    }
    expect(codeOfError(caught)).toBe('srv.account.locked');
    expect(calls).toHaveLength(0);
    expect(r.states()).toEqual([]);
  });

  it('(l) setAccount to a locked profile throws srv.account.locked and leaves the running job as it was', async () => {
    const r = mkRunner();
    const id = r.start(startReq('work'));
    finishTurn(children[0]);
    await until(() => r.states()[0].busy === false && r.states()[0].queued === 0);
    port.locked.add('home');
    let caught: unknown;
    try {
      await r.setAccount(id, 'home');
    } catch (e) {
      caught = e;
    }
    expect(codeOfError(caught)).toBe('srv.account.locked');
    expect(calls).toHaveLength(1);
    expect(r.accountOf(id)).toBe('work');
    expect(children[0].killedWith).toEqual([]);
  });

  it('(j) no token value appears in the state, the events, the argv or any error message', async () => {
    const r = mkRunner();
    const seen: unknown[] = [];
    r.on('account_switch', (e) => seen.push(e));
    const errors: string[] = [];
    const id = r.start(startReq('work'));
    try {
      r.adopt({ sessionId: '33333333-cccc', cwd: tmp, accountId: 'broken' });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    finishTurn(children[0]);
    await until(() => r.states()[0].busy === false && r.states()[0].queued === 0);
    await r.setAccount(id, 'home').catch((e: unknown) => errors.push(e instanceof Error ? e.message : String(e)));
    await until(() => children.length === 2);

    const everything = JSON.stringify({ states: r.states(), events: seen, errors, args: calls.map((c) => c.args) });
    for (const t of ALL_TOKENS) expect(everything).not.toContain(t);
    expect(JSON.stringify(children.map((c) => c.written))).not.toContain(TOKEN_A);
    expect(JSON.stringify(children.map((c) => c.written))).not.toContain(TOKEN_B);
    // the token is only in the child env
    expect(calls[1].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_B);
    expect(errors.join('|')).not.toContain('sk-ant-oat01');
  });
});
