// MainAccountService: the claude.ai login of the MAIN account (the one a plain `claude` run uses, outside any
// profile). Reads `claude auth status --json`, runs `claude auth login --claudeai` in a pseudo-console and
// `claude auth logout`. Nothing it handles is logged or emitted except the login URL and the status fields:
// never the email (outside MainAccountInfo), never the pasted code, never screen text.
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { validateLoginCode, type MainAccountInfo, type MainLoginEvent } from '../../shared/accounts';
import { type ChildLike, type SpawnFn, childEnv } from './runner';
import { CodedError } from './codedError';
import {
  type PtyFactory,
  type PtyProcess,
  type ScreenFactory,
  type ScreenLike,
  extractUrl,
  loadPty,
  xtermScreen,
} from './accountPty';

const DEFAULT_STATUS_TTL_MS = 60_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 600_000;
const DEFAULT_SETTLE_MS = 400;
const CLI_TIMEOUT_MS = 15_000;
const CLI_OUT_CAP = 64 * 1024;
const SCREEN_COLS = 300;
const SCREEN_ROWS = 60;

const PASTE_RE = /Paste code here/i;
const SUCCESS_RE = /Login successful/i;
const BROWSER_RE = /Opening browser|If the browser didn't open/;

export interface MainAccountServiceDeps {
  spawn?: SpawnFn;
  /** undefined = load node-pty in the constructor; null = no pty available. */
  pty?: PtyFactory | null;
  /** Screen model for the login (tests); default is the xterm screen. */
  screen?: ScreenFactory;
  claudeBin?: string;
  now?: () => number;
  /** True while a terminal job runs (logout would pull the login out from under it). */
  busyTerminalJobs?: () => boolean;
  log?: (m: string) => void;
  statusTtlMs?: number;
  loginTimeoutMs?: number;
  /** Debounce before the screen is read after output, and the grace before an exit is read. */
  settleMs?: number;
}

interface LoginRun {
  pty: PtyProcess;
  screen: ScreenLike;
  finished: boolean;
  needCode: boolean;
  url: string | null;
  shownKey: string | null;
  settleTimer?: ReturnType<typeof setTimeout>;
  exitTimer?: ReturnType<typeof setTimeout>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

function coded(code: string, message: string): CodedError {
  return new CodedError(message, code);
}

/** Epoch value to ms. Numbers below 1e11 are seconds (the CLI may print either). Null when unusable. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Parses the stdout of `claude auth status --json`. Anything unusable reads as logged out. */
export function parseAuthStatus(raw: string, checkedAt: number): MainAccountInfo {
  const loggedOut: MainAccountInfo = { loggedIn: false, email: null, plan: null, orgName: null, expiresAt: null, checkedAt };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return loggedOut;
  }
  if (typeof obj !== 'object' || obj === null) return loggedOut;
  const o = obj as Record<string, unknown>;
  if (o.loggedIn !== true) return loggedOut;
  return {
    loggedIn: true,
    email: strOrNull(o.email),
    plan: strOrNull(o.subscriptionType),
    orgName: strOrNull(o.orgName),
    expiresAt: toMs(o.loginExpiresAt),
    checkedAt,
  };
}

/** Whether two statuses differ in any field that matters (checkedAt excluded). */
function sameStatus(a: MainAccountInfo | null, b: MainAccountInfo): boolean {
  return (
    a !== null &&
    a.loggedIn === b.loggedIn &&
    a.email === b.email &&
    a.plan === b.plan &&
    a.orgName === b.orgName &&
    a.expiresAt === b.expiresAt
  );
}

/** Events: 'status' (MainAccountInfo, on change) and 'login' (MainLoginEvent). */
export class MainAccountService extends EventEmitter {
  private readonly spawnFn: SpawnFn;
  private ptyFactory: PtyFactory | null;
  private readonly screenFactory: ScreenFactory;
  private readonly now: () => number;
  private readonly deps: MainAccountServiceDeps;
  private last: MainAccountInfo | null = null;
  private cache: { at: number; info: MainAccountInfo } | null = null;
  private inflight: Promise<MainAccountInfo> | null = null;
  private run: LoginRun | null = null;
  private disposed = false;

  constructor(deps: MainAccountServiceDeps = {}) {
    super();
    this.deps = deps;
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.screenFactory = deps.screen ?? xtermScreen;
    this.now = deps.now ?? (() => Date.now());
    this.ptyFactory = deps.pty === undefined ? null : deps.pty;
    if (deps.pty === undefined) {
      // loadPty never throws; until it resolves, login() answers PTY_UNAVAILABLE.
      void loadPty().then((f) => {
        if (!this.disposed) this.ptyFactory = f;
      });
    }
  }

  /** Last known status, synchronously. Null until the first status() has finished. */
  info(): MainAccountInfo | null {
    return this.last;
  }

  /** Runs `claude auth status --json` (cached for statusTtlMs unless `force`). Never rejects: a failure reads as logged out. */
  status(force = false): Promise<MainAccountInfo> {
    if (!force && this.cache && this.now() - this.cache.at < (this.deps.statusTtlMs ?? DEFAULT_STATUS_TTL_MS)) {
      return Promise.resolve(this.cache.info);
    }
    if (this.inflight) return this.inflight;
    const p = this.runCli(['auth', 'status', '--json'])
      .then((out) => parseAuthStatus(out, this.now()))
      .catch(() => parseAuthStatus('', this.now()))
      .then((info) => {
        this.cache = { at: this.now(), info };
        this.setLast(info);
        return info;
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = p;
    return p;
  }

  /** Starts the claude.ai login in a pty. Progress arrives as 'login' events. Throws PTY_UNAVAILABLE / LOGIN_BUSY. */
  login(): void {
    const factory = this.ptyFactory;
    if (this.disposed || !factory) throw coded('PTY_UNAVAILABLE', 'No pseudo-console available on this machine');
    if (this.run) throw coded('LOGIN_BUSY', 'A login is already running');

    const screen = this.screenFactory(SCREEN_COLS, SCREEN_ROWS);
    let pty: PtyProcess;
    try {
      pty = factory(this.loginBin(), ['auth', 'login', '--claudeai'], {
        cols: SCREEN_COLS,
        rows: SCREEN_ROWS,
        cwd: os.tmpdir(),
        env: this.loginEnv(),
      });
    } catch {
      this.disposeScreen(screen);
      throw coded('PTY_UNAVAILABLE', 'The pseudo-console did not start');
    }

    const run: LoginRun = { pty, screen, finished: false, needCode: false, url: null, shownKey: null };
    this.run = run;
    this.log('main login started');
    this.emitLogin({ status: 'starting' });

    pty.onData((d) => {
      if (run.finished) return;
      screen.write(d, () => {
        if (run.finished) return;
        clearTimeout(run.settleTimer);
        run.settleTimer = setTimeout(() => this.check(run), this.deps.settleMs ?? DEFAULT_SETTLE_MS);
      });
    });
    pty.onExit((e) => this.onExit(run, e.exitCode));
    run.timeoutTimer = setTimeout(() => {
      if (run.finished) return;
      this.killRun(run);
      this.finish(run, { status: 'timeout' }, 'main login timed out');
    }, this.deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  }

  /** Types the pasted code into the running login. The code is never stored, logged or emitted. */
  writeCode(code: string): void {
    const valid = validateLoginCode(code);
    if (valid === null) throw coded('CODE_INVALID', 'The login code is not valid');
    const run = this.run;
    if (!run || run.finished) throw coded('NO_LOGIN_RUNNING', 'No login is running');
    run.pty.write(valid + '\r');
  }

  /** Kills the running login by its pid. True when one was running. */
  cancelLogin(): boolean {
    const run = this.run;
    if (!run || run.finished) return false;
    this.killRun(run);
    this.finish(run, { status: 'cancelled' }, 'main login cancelled');
    return true;
  }

  /** `claude auth logout`, then a fresh status. BUSY_JOBS while a terminal job runs, LOGIN_BUSY while a login runs. */
  async logout(): Promise<MainAccountInfo> {
    if (this.deps.busyTerminalJobs?.()) throw coded('BUSY_JOBS', 'Terminal jobs are running');
    if (this.run) throw coded('LOGIN_BUSY', 'A login is running');
    await this.runCli(['auth', 'logout']).catch(() => undefined);
    this.log('main logout done');
    return this.status(true);
  }

  dispose(): void {
    this.cancelLogin();
    this.disposed = true;
  }

  // ---- login internals ----

  /** Reads the screen: success, then the login URL and the paste prompt. Emits 'waiting_browser' when either changes. */
  private check(run: LoginRun): void {
    if (run.finished) return;
    let lines: string[];
    try {
      lines = run.screen.lines();
    } catch {
      this.finish(run, { status: 'failed', error: 'LOGIN_FAILED' }, 'main login failed (screen)');
      return;
    }
    const text = lines.join('\n');
    if (SUCCESS_RE.test(text)) {
      this.succeed(run);
      return;
    }
    const url = extractUrl(lines);
    if (url !== null) run.url = url;
    if (PASTE_RE.test(text)) run.needCode = true;
    const found = run.url !== null || run.needCode || BROWSER_RE.test(text);
    if (!found) return;
    const key = `${run.url ?? ''}|${run.needCode ? 1 : 0}`;
    if (key === run.shownKey) return;
    run.shownKey = key;
    this.emitLogin({
      status: 'waiting_browser',
      ...(run.url !== null ? { url: run.url } : {}),
      ...(run.needCode ? { needCode: true } : {}),
    });
  }

  private onExit(run: LoginRun, exitCode: number): void {
    if (run.finished) return;
    clearTimeout(run.exitTimer);
    // The screen may still be flushing: read it after a short grace, then decide.
    run.exitTimer = setTimeout(() => {
      if (run.finished) return;
      this.check(run);
      if (run.finished) return;
      if (exitCode === 0) this.succeed(run);
      else this.finish(run, { status: 'failed', error: 'LOGIN_FAILED' }, 'main login failed');
    }, this.deps.settleMs ?? DEFAULT_SETTLE_MS);
  }

  private succeed(run: LoginRun): void {
    this.killRun(run);
    this.finish(run, { status: 'success' }, 'main login succeeded');
    void this.status(true);
  }

  /** Ends the run once: clears its timers, disposes its screen, frees the slot, then emits the final event. */
  private finish(run: LoginRun, ev: MainLoginEvent, logMsg: string): void {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.settleTimer);
    clearTimeout(run.exitTimer);
    clearTimeout(run.timeoutTimer);
    this.disposeScreen(run.screen);
    if (this.run === run) this.run = null;
    this.log(logMsg);
    this.emitLogin(ev);
  }

  private killRun(run: LoginRun): void {
    try {
      run.pty.kill();
    } catch {
      // already gone
    }
  }

  private disposeScreen(screen: ScreenLike): void {
    try {
      screen.dispose();
    } catch {
      // ignore
    }
  }

  private setLast(info: MainAccountInfo): void {
    const changed = !sameStatus(this.last, info);
    this.last = info;
    if (changed) this.emitStatus(info);
  }

  private emitStatus(info: MainAccountInfo): void {
    try {
      this.emit('status', info);
    } catch {
      // a listener failure must not break the status read
    }
  }

  private emitLogin(ev: MainLoginEvent): void {
    try {
      this.emit('login', ev);
    } catch {
      // a listener failure must not break the login
    }
  }

  private loginBin(): string {
    return this.deps.claudeBin ?? process.env.CR_CLAUDE_BIN ?? (process.platform === 'win32' ? 'claude.exe' : 'claude');
  }

  private cliBin(): string {
    return this.deps.claudeBin ?? process.env.CR_CLAUDE_BIN ?? 'claude';
  }

  /** Env for the login pty: no CLAUDE* (childEnv) and no API keys that would override the claude.ai login. */
  private loginEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(childEnv())) {
      if (typeof v !== 'string') continue;
      if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') continue;
      env[k] = v;
    }
    return env;
  }

  /** One plain CLI run; resolves its stdout (capped at CLI_OUT_CAP, '' when over). Rejects on spawn failure, error or timeout. Stderr is dropped. */
  private runCli(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };
      let child: ChildLike;
      try {
        child = this.spawnFn(this.cliBin(), args, { cwd: os.tmpdir(), env: childEnv() });
      } catch {
        reject(new Error('spawn failed'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      child.stdout.on('data', (d: Buffer | string) => {
        const b = typeof d === 'string' ? Buffer.from(d) : d;
        if (truncated) return;
        bytes += b.length;
        if (bytes > CLI_OUT_CAP) {
          truncated = true;
          return;
        }
        chunks.push(b);
      });
      child.stderr?.on('data', () => undefined);
      child.stdin.on('error', () => undefined);
      child.on('error', () => done(() => reject(new Error('child error'))));
      child.on('close', () => {
        const out = truncated ? '' : Buffer.concat(chunks).toString('utf8');
        done(() => resolve(out));
      });
      try {
        child.stdin.end();
      } catch {
        // the CLI reads nothing from stdin
      }
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        done(() => reject(new Error('timeout')));
      }, CLI_TIMEOUT_MS);
    });
  }

  private log(m: string): void {
    try {
      this.deps.log?.(m);
    } catch {
      // logging must never break the service
    }
  }
}

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as unknown as ChildLike;
