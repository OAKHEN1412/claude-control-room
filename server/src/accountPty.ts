// Runs `claude setup-token` in a pseudo-console and captures the OAuth token from the RENDERED screen.
// The raw output stream is never matched: wrapped rows are joined by the screen model first.
// Nothing from the pty is logged or forwarded except into the screen model; the token only leaves
// through the `done` result (and never through a status event).
import { createRequire } from 'node:module';
import type { Terminal as XTerminal } from '@xterm/headless';

export interface PtyProcess {
  pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  /** Types into the terminal (the login flow writes the pasted code + CR here). Never log what is written. */
  write(data: string): void;
  kill(): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyProcess;

export interface ScreenLike {
  write(data: string, cb: () => void): void;
  /** Logical lines: rows flagged as wrapped are joined onto the line above them. */
  lines(): string[];
  dispose(): void;
}

export type ScreenFactory = (cols: number, rows: number) => ScreenLike;

const SCREEN_COLS = 300;
const SCREEN_ROWS = 60;
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;
const URL_RE = /https:\/\/[^\s<>"'`()[\]{}]+/g;
const BROWSER_RE = /Opening browser|Browser didn't open/;
const ALLOWED_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'];

interface PtySpawn {
  (
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): {
    pid: number;
    onData(cb: (d: string) => void): unknown;
    onExit(cb: (e: { exitCode: number }) => void): unknown;
    write(data: string): unknown;
    kill(): void;
  };
}

/** Loads node-pty and wraps its spawn into a PtyFactory. Null when the native module does not load. Never throws. */
export async function loadPty(): Promise<PtyFactory | null> {
  try {
    const mod = (await import('@lydell/node-pty')) as unknown as {
      spawn?: PtySpawn;
      default?: { spawn?: PtySpawn };
    };
    const spawn = mod.spawn ?? mod.default?.spawn;
    if (typeof spawn !== 'function') return null;
    const factory: PtyFactory = (file, args, opts) => {
      const p = spawn(file, args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
      });
      return {
        pid: p.pid,
        onData: (cb) => {
          p.onData((d) => cb(d));
        },
        onExit: (cb) => {
          p.onExit((e) => cb({ exitCode: e.exitCode }));
        },
        write: (data) => p.write(data),
        kill: () => p.kill(),
      };
    };
    return factory;
  } catch {
    return null;
  }
}

/** Screen model backed by @xterm/headless. */
export function xtermScreen(cols: number, rows: number): ScreenLike {
  // @xterm/headless is CommonJS; a named ESM import fails under Node ESM (tsx), so load it lazily via require.
  const require = createRequire(import.meta.url);
  const { Terminal } = require('@xterm/headless') as { Terminal: typeof XTerminal };
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 });
  return {
    write(data, cb) {
      term.write(data, cb);
    },
    lines() {
      const out: string[] = [];
      const buf = term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        const s = line.translateToString(true);
        if (line.isWrapped && out.length > 0) out[out.length - 1] += s;
        else out.push(s);
      }
      return out;
    },
    dispose() {
      term.dispose();
    },
  };
}

/** First OAuth token on the screen, or null. */
export function extractToken(lines: string[]): string | null {
  const m = TOKEN_RE.exec(lines.join('\n'));
  return m ? m[0] : null;
}

/** First https link on the screen to claude.ai / claude.com / anthropic.com (or a subdomain), or null. */
export function extractUrl(lines: string[]): string | null {
  const text = lines.join('\n');
  for (const m of text.matchAll(URL_RE)) {
    let u: URL;
    try {
      u = new URL(m[0]);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:') continue;
    const host = u.hostname.toLowerCase();
    const ok = ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    if (ok) return u.href;
  }
  return null;
}

export interface SetupTokenStatus {
  status: 'waiting_browser' | 'captured';
  url?: string;
}

export interface SetupTokenOptions {
  pty: PtyFactory;
  screen?: ScreenFactory;
  bin: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  onStatus: (s: SetupTokenStatus) => void;
  settleMs?: number;
}

export type SetupTokenResult = { ok: true; token: string } | { ok: false; error: 'timeout' | 'cancelled' | 'failed' };

/** Runs `bin setup-token` in a pty and resolves with the token read from the rendered screen. */
export function startSetupToken(o: SetupTokenOptions): { pid: number; done: Promise<SetupTokenResult>; cancel(): void } {
  const settleMs = o.settleMs ?? 400;
  const screen = (o.screen ?? xtermScreen)(SCREEN_COLS, SCREEN_ROWS);

  let resolveDone!: (r: SetupTokenResult) => void;
  const done = new Promise<SetupTokenResult>((r) => (resolveDone = r));
  let finished = false;
  let proc: PtyProcess | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  // undefined = a URL-less "browser" notice was shown; null = nothing shown yet; string = URL shown.
  let shown: string | undefined | null = null;

  const emit = (s: SetupTokenStatus): void => {
    try {
      o.onStatus(s);
    } catch {
      // a listener failure must not break the capture
    }
  };

  const killProc = (): void => {
    try {
      proc?.kill();
    } catch {
      // already gone
    }
  };

  const finish = (r: SetupTokenResult): void => {
    if (finished) return;
    finished = true;
    clearTimeout(settleTimer);
    clearTimeout(exitTimer);
    clearTimeout(timeoutTimer);
    try {
      screen.dispose();
    } catch {
      // ignore
    }
    resolveDone(r);
  };

  const check = (): void => {
    if (finished) return;
    let lines: string[];
    try {
      lines = screen.lines();
    } catch {
      finish({ ok: false, error: 'failed' });
      return;
    }
    const token = extractToken(lines);
    if (token !== null) {
      emit({ status: 'captured' });
      killProc();
      finish({ ok: true, token });
      return;
    }
    const url = extractUrl(lines);
    if (url !== null) {
      if (url !== shown) {
        shown = url;
        emit({ status: 'waiting_browser', url });
      }
    } else if (shown === null && BROWSER_RE.test(lines.join('\n'))) {
      shown = undefined;
      emit({ status: 'waiting_browser' });
    }
  };

  const onExit = (): void => {
    if (finished) return;
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      if (finished) return;
      check();
      finish({ ok: false, error: 'failed' });
    }, 800);
  };

  try {
    proc = o.pty(o.bin, ['setup-token'], { cols: SCREEN_COLS, rows: SCREEN_ROWS, cwd: o.cwd, env: o.env });
    const p = proc;
    p.onData((d) => {
      if (finished) return;
      screen.write(d, () => {
        if (finished) return;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(check, settleMs);
      });
    });
    p.onExit(onExit);
    timeoutTimer = setTimeout(() => {
      if (finished) return;
      killProc();
      finish({ ok: false, error: 'timeout' });
    }, o.timeoutMs);
  } catch {
    finish({ ok: false, error: 'failed' });
  }

  return {
    pid: proc?.pid ?? 0,
    done,
    cancel(): void {
      if (finished) return;
      killProc();
      finish({ ok: false, error: 'cancelled' });
    },
  };
}
