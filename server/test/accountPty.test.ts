import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractToken,
  extractUrl,
  startSetupToken,
  xtermScreen,
  type PtyFactory,
  type PtyProcess,
  type ScreenLike,
  type SetupTokenStatus,
} from '../src/accountPty';

const FAKE_TOKEN = 'sk-ant-oat01-' + 'FAKE0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
const URL_A = 'https://claude.ai/oauth/x?a=b';
const URL_B = 'https://claude.com/oauth/y';

/** Fake pty: the test pushes data / exit through the captured callbacks. */
class FakePty implements PtyProcess {
  pid = 777;
  kill = vi.fn();
  dataCb: ((d: string) => void) | null = null;
  exitCb: ((e: { exitCode: number }) => void) | null = null;
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }
  written: string[] = [];
  write(data: string): void {
    this.written.push(data);
  }
  push(d: string): void {
    this.dataCb?.(d);
  }
  exit(code = 1): void {
    this.exitCb?.({ exitCode: code });
  }
}

/** Fake screen: the test sets `text` (the rendered logical lines); write() acknowledges at once. */
class FakeScreen implements ScreenLike {
  text: string[] = [];
  disposed = 0;
  write(_data: string, cb: () => void): void {
    cb();
  }
  lines(): string[] {
    return this.text;
  }
  dispose(): void {
    this.disposed++;
  }
}

function setup(opts: { settleMs?: number; timeoutMs?: number } = {}) {
  const pty = new FakePty();
  const screen = new FakeScreen();
  const factory = vi.fn<PtyFactory>(() => pty);
  const statuses: SetupTokenStatus[] = [];
  const run = startSetupToken({
    pty: factory,
    screen: () => screen,
    bin: '/fake/claude',
    cwd: '/fake',
    env: {},
    timeoutMs: opts.timeoutMs ?? 60_000,
    settleMs: opts.settleMs ?? 400,
    onStatus: (s) => statuses.push(s),
  });
  return { pty, screen, factory, statuses, run };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('extractToken', () => {
  it('finds the token in a logical line that was joined from wrapped rows', () => {
    expect(extractToken(['Paste this: sk-ant-oat01-abcDEF_123-xyz and go'])).toBe('sk-ant-oat01-abcDEF_123-xyz');
  });

  it('stops at a real line break (rows that were not joined)', () => {
    expect(extractToken(['Paste this: sk-ant-oat01-abc', 'DEF_123-xyz and go', ''])).toBe('sk-ant-oat01-abc');
  });

  it('returns null when the screen has no token', () => {
    expect(extractToken(["Browser didn't open", 'sk-ant-api03-nope', ''])).toBeNull();
    expect(extractToken([])).toBeNull();
  });
});

describe('extractUrl', () => {
  it('accepts https links on the allowed hosts and their subdomains', () => {
    expect(extractUrl([`Open: ${URL_A}`])).toBe(URL_A);
    expect(extractUrl([`go ${URL_B} now`])).toBe(URL_B);
    expect(extractUrl(['https://console.anthropic.com/x'])).toBe('https://console.anthropic.com/x');
  });

  it('rejects http, look-alike and suffix-trick hosts', () => {
    expect(extractUrl(['http://claude.ai/oauth/x'])).toBeNull();
    expect(extractUrl(['https://evil.example/claude.ai'])).toBeNull();
    expect(extractUrl(['https://claude.ai.evil.com/x'])).toBeNull();
    expect(extractUrl(['https://notclaude.ai/x'])).toBeNull();
  });

  it('skips a rejected link and takes the next allowed one', () => {
    expect(extractUrl(['https://evil.example/x', URL_A])).toBe(URL_A);
  });
});

describe('startSetupToken', () => {
  it('spawns the bin with setup-token at 300x60 and reports its pid', () => {
    const { factory, run } = setup();
    expect(factory).toHaveBeenCalledWith(
      '/fake/claude',
      ['setup-token'],
      expect.objectContaining({ cols: 300, rows: 60, cwd: '/fake' }),
    );
    expect(run.pid).toBe(777);
    run.cancel();
  });

  it('emits waiting_browser once per distinct url', async () => {
    const { pty, screen, statuses, run } = setup({ settleMs: 100 });
    screen.text = [`Visit ${URL_A}`];
    pty.push('x');
    await vi.advanceTimersByTimeAsync(100);
    pty.push('y');
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses).toEqual([{ status: 'waiting_browser', url: URL_A }]);

    screen.text = [`Visit ${URL_B}`];
    pty.push('z');
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses).toEqual([
      { status: 'waiting_browser', url: URL_A },
      { status: 'waiting_browser', url: URL_B },
    ]);
    run.cancel();
  });

  it('emits waiting_browser without url on the browser notice, then with url when it appears', async () => {
    const { pty, screen, statuses, run } = setup({ settleMs: 100 });
    screen.text = ['Opening browser to sign in'];
    pty.push('x');
    await vi.advanceTimersByTimeAsync(100);
    screen.text = ['Opening browser to sign in', URL_A];
    pty.push('y');
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses).toEqual([{ status: 'waiting_browser' }, { status: 'waiting_browser', url: URL_A }]);
    run.cancel();
  });

  it('captures the token from the screen: captured status, kill once, ok result, token never in statuses', async () => {
    const { pty, screen, statuses, run } = setup({ settleMs: 100 });
    screen.text = [`Visit ${URL_A}`];
    pty.push('x');
    await vi.advanceTimersByTimeAsync(100);
    screen.text = ['Paste code:', FAKE_TOKEN];
    pty.push('y');
    await vi.advanceTimersByTimeAsync(100);

    await expect(run.done).resolves.toEqual({ ok: true, token: FAKE_TOKEN });
    expect(statuses[statuses.length - 1]).toEqual({ status: 'captured' });
    expect(statuses.filter((s) => s.status === 'captured')).toHaveLength(1);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(screen.disposed).toBe(1);
    expect(JSON.stringify(statuses)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(statuses)).not.toContain('sk-ant-oat01-');
  });

  it('resolves failed when the pty exits without a token', async () => {
    const { pty, screen, run } = setup({ settleMs: 100 });
    screen.text = ['Some error'];
    pty.push('x');
    pty.exit(1);
    await vi.advanceTimersByTimeAsync(800);
    await expect(run.done).resolves.toEqual({ ok: false, error: 'failed' });
    expect(pty.kill).not.toHaveBeenCalled();
  });

  it('captures a token that is on the final screen after exit', async () => {
    const { pty, screen, run } = setup({ settleMs: 100 });
    pty.push('x');
    screen.text = [FAKE_TOKEN];
    pty.exit(0);
    await vi.advanceTimersByTimeAsync(800);
    await expect(run.done).resolves.toEqual({ ok: true, token: FAKE_TOKEN });
  });

  it('resolves timeout and kills the pty', async () => {
    const { pty, run } = setup({ timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(run.done).resolves.toEqual({ ok: false, error: 'timeout' });
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it('cancel resolves cancelled and kills the pty', async () => {
    const { pty, run } = setup();
    run.cancel();
    await expect(run.done).resolves.toEqual({ ok: false, error: 'cancelled' });
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it('resolves only once: cancel after a captured token is a no-op', async () => {
    const { pty, screen, run } = setup({ settleMs: 100 });
    screen.text = [FAKE_TOKEN];
    pty.push('x');
    await vi.advanceTimersByTimeAsync(100);
    run.cancel();
    await expect(run.done).resolves.toEqual({ ok: true, token: FAKE_TOKEN });
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it('resolves only once: a later timeout does not change the result', async () => {
    const { pty, screen, run } = setup({ settleMs: 100, timeoutMs: 5000 });
    screen.text = [FAKE_TOKEN];
    pty.push('x');
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(run.done).resolves.toEqual({ ok: true, token: FAKE_TOKEN });
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it('a throwing kill does not break cancel', async () => {
    const { pty, run } = setup();
    pty.kill.mockImplementation(() => {
      throw new Error('AttachConsole failed');
    });
    run.cancel();
    await expect(run.done).resolves.toEqual({ ok: false, error: 'cancelled' });
  });
});

describe('xtermScreen', () => {
  // xterm's write queue relies on real timers, so this block opts out of the fake clock.
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('renders plain text rows', async () => {
    const s = xtermScreen(10, 10);
    await new Promise<void>((r) => s.write('hello\r\nwor', r));
    await new Promise<void>((r) => s.write('ld', r));
    expect(s.lines().filter((l) => l.trim() !== '')).toEqual(['hello', 'world']);
    s.dispose();
  });

  it('joins a wrapped long row into one logical line', async () => {
    const s = xtermScreen(10, 10);
    await new Promise<void>((r) => s.write('abcdefghijklmnopqrs', r));
    expect(s.lines().filter((l) => l.trim() !== '')).toEqual(['abcdefghijklmnopqrs']);
    s.dispose();
  });
});
