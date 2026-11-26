import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainLoginEvent } from '../../shared/accounts';
import { parseAuthStatus, MainAccountService, type MainAccountServiceDeps } from '../src/mainAccount';
import type { ChildLike, SpawnFn } from '../src/runner';
import type { PtyFactory, PtyProcess, ScreenLike } from '../src/accountPty';

// Fake values only, shaped like real ones. Never real credentials or accounts.
const LOGGED_IN = {
  loggedIn: true,
  authMethod: 'claude.ai',
  email: 'a@b.c',
  orgName: 'Org',
  subscriptionType: 'max',
  loginExpiresAt: '2026-12-01T00:00:00Z',
};
const LOGGED_OUT = { loggedIn: false, authMethod: 'none' };
const URL_A = 'https://claude.ai/oauth/authorize?code=true&state=abc';
const CODE = 'ZQX991';

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.restoreAllMocks();
});

/** Fake CLI child: stdout is delivered, then close with the given code. `'error'` emits an error instead. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  kill = vi.fn(() => true);
}

type CliReply = { stdout: string; code?: number } | 'throw' | 'error';

function cliSpawn(reply: (args: string[]) => CliReply): SpawnFn & ReturnType<typeof vi.fn> {
  return vi.fn((_cmd: string, args: string[]) => {
    const r = reply(args);
    if (r === 'throw') throw new Error('spawn failed');
    const c = new FakeChild();
    setImmediate(() => {
      if (r === 'error') {
        c.emit('error', new Error('child error'));
        return;
      }
      c.stdout.on('end', () => c.emit('close', r.code ?? 0));
      c.stdout.end(r.stdout);
    });
    return c as unknown as ChildLike;
  }) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
}

/** Fake pty: the test pushes output / exit through the captured callbacks and reads what was written. */
class FakePty implements PtyProcess {
  pid = 777;
  kill = vi.fn();
  written: string[] = [];
  dataCb: ((d: string) => void) | null = null;
  exitCb: ((e: { exitCode: number }) => void) | null = null;
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }
  write(data: string): void {
    this.written.push(data);
  }
  push(d: string): void {
    this.dataCb?.(d);
  }
  exit(code: number): void {
    this.exitCb?.({ exitCode: code });
  }
}

/** Fake screen: the test sets `text`; write() acknowledges at once. */
class FakeScreen implements ScreenLike {
  text: string[] = [];
  dispose = vi.fn();
  write(_data: string, cb: () => void): void {
    cb();
  }
  lines(): string[] {
    return this.text;
  }
}

interface Harness {
  svc: MainAccountService;
  pty: FakePty;
  screen: FakeScreen;
  ptyFactory: ReturnType<typeof vi.fn>;
  spawn: SpawnFn & ReturnType<typeof vi.fn>;
  logs: string[];
  events: MainLoginEvent[];
  cli: { loggedIn: boolean };
  clock: { t: number };
}

function harness(over: Partial<MainAccountServiceDeps> = {}): Harness {
  const pty = new FakePty();
  const screen = new FakeScreen();
  const ptyFactory = vi.fn<PtyFactory>(() => pty);
  const cli = { loggedIn: true };
  const clock = { t: 1_000_000 };
  const spawn = cliSpawn((args) => {
    if (args.includes('status')) return { stdout: JSON.stringify(cli.loggedIn ? LOGGED_IN : LOGGED_OUT) };
    if (args.includes('logout')) {
      cli.loggedIn = false;
      return { stdout: '' };
    }
    return 'error';
  });
  const logs: string[] = [];
  const svc = new MainAccountService({
    spawn,
    pty: ptyFactory,
    screen: () => screen,
    claudeBin: '/fake/claude',
    now: () => clock.t,
    log: (m) => logs.push(m),
    settleMs: 5,
    loginTimeoutMs: 2000,
    ...over,
  });
  const events: MainLoginEvent[] = [];
  svc.on('login', (e: MainLoginEvent) => events.push(e));
  return { svc, pty, screen, ptyFactory, spawn, logs, events, cli, clock };
}

/** The error code of a synchronous or async call that is expected to fail. */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { srvCode?: string }).srvCode;
  }
  return undefined;
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return (e as { srvCode?: string }).srvCode;
  }
  return undefined;
}

describe('parseAuthStatus', () => {
  it('reads a logged-in status and maps the fields', () => {
    const info = parseAuthStatus(JSON.stringify(LOGGED_IN), 5);
    expect(info).toEqual({
      loggedIn: true,
      email: 'a@b.c',
      plan: 'max',
      orgName: 'Org',
      expiresAt: Date.parse('2026-12-01T00:00:00Z'),
      checkedAt: 5,
    });
  });

  it('reads the logged-out form as logged out with nulls', () => {
    expect(parseAuthStatus(JSON.stringify(LOGGED_OUT), 5)).toEqual({
      loggedIn: false,
      email: null,
      plan: null,
      orgName: null,
      expiresAt: null,
      checkedAt: 5,
    });
  });

  it('accepts an epoch expiry in seconds or milliseconds and treats garbage as logged out', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, loginExpiresAt: 1764547200 }), 0).expiresAt).toBe(1764547200000);
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, loginExpiresAt: 1764547200000 }), 0).expiresAt).toBe(1764547200000);
    expect(parseAuthStatus('not json', 0).loggedIn).toBe(false);
    expect(parseAuthStatus('null', 0).loggedIn).toBe(false);
    expect(parseAuthStatus(JSON.stringify({ loggedIn: 'yes' }), 0).loggedIn).toBe(false);
  });
});

describe('MainAccountService.status', () => {
  it('spawns `claude auth status --json` and stores the parsed result', async () => {
    const h = harness();
    expect(h.svc.info()).toBeNull();
    const info = await h.svc.status();
    expect(info.loggedIn).toBe(true);
    expect(info.email).toBe('a@b.c');
    expect(h.svc.info()).toEqual(info);
    expect(h.spawn).toHaveBeenCalledWith('/fake/claude', ['auth', 'status', '--json'], expect.any(Object));
  });

  it('reads as logged out when the spawn throws or the child errors', async () => {
    const throwing = harness({ spawn: cliSpawn(() => 'throw') });
    expect((await throwing.svc.status()).loggedIn).toBe(false);
    const erroring = harness({ spawn: cliSpawn(() => 'error') });
    expect((await erroring.svc.status()).loggedIn).toBe(false);
  });

  it('caches for 60 s, and force bypasses the cache', async () => {
    const h = harness();
    await h.svc.status();
    await h.svc.status();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.clock.t += 59_000;
    await h.svc.status();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.clock.t += 2_000;
    await h.svc.status();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    await h.svc.status(true);
    expect(h.spawn).toHaveBeenCalledTimes(3);
  });

  it('shares one run between concurrent calls', async () => {
    const h = harness();
    await Promise.all([h.svc.status(), h.svc.status(), h.svc.status()]);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('emits status only when a field changes, and never logs the email', async () => {
    const h = harness();
    const seen: boolean[] = [];
    h.svc.on('status', (i: { loggedIn: boolean }) => seen.push(i.loggedIn));
    await h.svc.status();
    await h.svc.status(true);
    expect(seen).toEqual([true]);
    h.cli.loggedIn = false;
    await h.svc.status(true);
    expect(seen).toEqual([true, false]);
    expect(JSON.stringify(h.logs)).not.toContain('a@b.c');
  });
});

describe('MainAccountService login', () => {
  it('runs `claude auth login --claudeai` in a 300x60 pty with a clean env', () => {
    const h = harness();
    h.svc.login();
    expect(h.ptyFactory).toHaveBeenCalledWith(
      '/fake/claude',
      ['auth', 'login', '--claudeai'],
      expect.objectContaining({ cols: 300, rows: 60 }),
    );
    const env = h.ptyFactory.mock.calls[0][2].env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('emits starting, then waiting_browser with the url and the paste prompt, then success', async () => {
    const h = harness();
    h.svc.login();
    expect(h.events).toEqual([{ status: 'starting' }]);

    h.screen.text = ['Opening browser to sign in…'];
    h.pty.push('x');
    await tick();
    expect(h.events.at(-1)).toEqual({ status: 'waiting_browser' });

    h.screen.text = ["If the browser didn't open, visit:", URL_A, 'Paste code here if prompted >'];
    h.pty.push('x');
    await tick();
    expect(h.events.at(-1)).toEqual({ status: 'waiting_browser', url: URL_A, needCode: true });

    h.screen.text = [...h.screen.text, 'Login successful.'];
    h.pty.push('x');
    await tick();
    expect(h.events.at(-1)).toEqual({ status: 'success' });
    expect(h.spawn).toHaveBeenCalledWith('/fake/claude', ['auth', 'status', '--json'], expect.any(Object));
    expect(h.pty.kill).toHaveBeenCalled();
    expect(h.screen.dispose).toHaveBeenCalled();
  });

  it('ignores urls outside claude.ai / claude.com / anthropic.com', async () => {
    const h = harness();
    h.svc.login();
    h.screen.text = ['visit https://evil.example/oauth'];
    h.pty.push('x');
    await tick();
    expect(h.events).toEqual([{ status: 'starting' }]);
  });

  it('reports success on exit code 0 without the success text', async () => {
    const h = harness();
    h.svc.login();
    h.pty.exit(0);
    await tick();
    expect(h.events.at(-1)).toEqual({ status: 'success' });
  });

  it('reports failed with LOGIN_FAILED on a non-zero exit without the success text', async () => {
    const h = harness();
    h.svc.login();
    h.pty.exit(1);
    await tick();
    expect(h.events.at(-1)).toEqual({ status: 'failed', error: 'LOGIN_FAILED' });
    expect(codeOf(() => h.svc.writeCode(CODE))).toBe('NO_LOGIN_RUNNING');
  });

  it('throws PTY_UNAVAILABLE when there is no pty, LOGIN_BUSY for a second login, and disposes the screen if the pty will not start', () => {
    expect(codeOf(() => harness({ pty: null }).svc.login())).toBe('PTY_UNAVAILABLE');

    const h = harness();
    h.svc.login();
    expect(codeOf(() => h.svc.login())).toBe('LOGIN_BUSY');

    const broken = harness({
      pty: () => {
        throw new Error('no conpty');
      },
    });
    expect(codeOf(() => broken.svc.login())).toBe('PTY_UNAVAILABLE');
    expect(broken.screen.dispose).toHaveBeenCalled();
  });

  it('times out: emits timeout and kills the pid', async () => {
    const h = harness({ loginTimeoutMs: 30 });
    h.svc.login();
    await tick(80);
    expect(h.events.at(-1)).toEqual({ status: 'timeout' });
    expect(h.pty.kill).toHaveBeenCalledTimes(1);
    expect(h.svc.cancelLogin()).toBe(false);
  });

  it('cancelLogin kills the pty by its pid, emits cancelled once and frees the slot', () => {
    const h = harness();
    h.svc.login();
    expect(h.svc.cancelLogin()).toBe(true);
    expect(h.pty.kill).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toEqual({ status: 'cancelled' });
    expect(h.svc.cancelLogin()).toBe(false);
    expect(() => h.svc.login()).not.toThrow();
  });

  it('dispose cancels a running login', () => {
    const h = harness();
    h.svc.login();
    h.svc.dispose();
    expect(h.pty.kill).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)).toEqual({ status: 'cancelled' });
    expect(codeOf(() => h.svc.login())).toBe('PTY_UNAVAILABLE');
  });
});

describe('MainAccountService writeCode', () => {
  it('writes the code with a carriage return into the running login', () => {
    const h = harness();
    h.svc.login();
    h.svc.writeCode(`  ${CODE}  `);
    expect(h.pty.written).toEqual([`${CODE}\r`]);
  });

  it('refuses an invalid code with CODE_INVALID and writes nothing', () => {
    const h = harness();
    h.svc.login();
    expect(codeOf(() => h.svc.writeCode(''))).toBe('CODE_INVALID');
    expect(codeOf(() => h.svc.writeCode('a\u0007b'))).toBe('CODE_INVALID');
    expect(codeOf(() => h.svc.writeCode('x'.repeat(513)))).toBe('CODE_INVALID');
    expect(codeOf(() => h.svc.writeCode(42 as unknown as string))).toBe('CODE_INVALID');
    expect(h.pty.written).toEqual([]);
  });

  it('refuses with NO_LOGIN_RUNNING when no login runs', () => {
    const h = harness();
    expect(codeOf(() => h.svc.writeCode(CODE))).toBe('NO_LOGIN_RUNNING');
    expect(h.pty.written).toEqual([]);
  });

  it('never puts the code into events or logs', async () => {
    const h = harness();
    h.svc.login();
    h.svc.writeCode(CODE);
    h.pty.exit(0);
    await tick();
    expect(JSON.stringify(h.events)).not.toContain(CODE);
    expect(JSON.stringify(h.logs)).not.toContain(CODE);
  });
});

describe('MainAccountService logout', () => {
  it('refuses with BUSY_JOBS while terminal jobs run', async () => {
    const h = harness({ busyTerminalJobs: () => true });
    expect(await codeOfAsync(() => h.svc.logout())).toBe('BUSY_JOBS');
    expect(h.spawn).not.toHaveBeenCalledWith(expect.anything(), ['auth', 'logout'], expect.anything());
  });

  it('refuses with LOGIN_BUSY while a login runs', async () => {
    const h = harness();
    h.svc.login();
    expect(await codeOfAsync(() => h.svc.logout())).toBe('LOGIN_BUSY');
  });

  it('runs `claude auth logout`, then refreshes the status', async () => {
    const h = harness();
    await h.svc.status();
    const info = await h.svc.logout();
    expect(h.spawn).toHaveBeenCalledWith('/fake/claude', ['auth', 'logout'], expect.any(Object));
    expect(info.loggedIn).toBe(false);
    expect(h.svc.info()?.loggedIn).toBe(false);
  });
});

describe('MainAccountService leak checks', () => {
  it('keeps the email out of the logs across status, login and logout', async () => {
    const h = harness();
    await h.svc.status();
    h.svc.login();
    h.pty.exit(0);
    await tick();
    await h.svc.logout();
    expect(JSON.stringify(h.logs)).not.toContain('a@b.c');
  });
});
