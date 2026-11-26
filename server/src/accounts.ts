// AccountService: the Claude profiles (accounts) of this server. Owns the in-memory tokens, the profile rows in SQLite
// (never the token), the `claude -p` health check and the `claude setup-token` capture flow.
// Invariant: a token value leaves this file only into the env of a child process, the secret store, or the memory map.
// Never into events, logs, errors, the db or argv.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import {
  ACCOUNT_COLORS,
  ACCOUNT_ID_RE,
  RESERVED_ACCOUNT_IDS,
  TERMINAL_ACCOUNT_ID,
  TOKEN_LIFETIME_MS,
  TOKEN_RE,
  defaultLetter,
  validatePassword,
  validateProfileInput,
  type AccountInfo,
  type AccountUsage,
  type AccountsView,
  type ConnectEvent,
  type MainAccountInfo,
} from '../../shared/accounts';
import { parseRateLimitEvent } from '../../shared/usage';
import type { AccountPort } from './accountPort';
import { decryptToken, encryptToken, isEnvelope } from './accountCrypto';
import { type ChildLike, type SpawnFn, childEnv, CommandError } from './runner';
import { CodedError } from './codedError';
import { type PtyFactory, type ScreenFactory, type SetupTokenResult, loadPty, startSetupToken } from './accountPty';
import type { AccountRow } from './db';

/** The account part of WorklogDb (db.ts). WorklogDb satisfies it; tests may pass a fake. */
export interface AccountsStore {
  listAccounts(): AccountRow[];
  getAccount(id: string): AccountRow | null;
  insertAccount(row: AccountRow): void;
  updateAccount(id: string, patch: Partial<Omit<AccountRow, 'id' | 'createdAt'>>): boolean;
  deleteAccount(id: string): boolean;
  getAccountSetting(key: string): string | null;
  setAccountSetting(key: string, value: string): void;
  getSessionAccount(sessionId: string): string | null;
  setSessionAccount(sessionId: string, accountId: string, at: number): void;
  pruneSessionAccounts(olderThanMs: number): number;
}

export interface AccountSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface AccountServiceDeps {
  db: AccountsStore;
  secrets: AccountSecrets;
  now?: () => number;
  spawn?: SpawnFn;
  claudeBin?: string;
  /** undefined = load node-pty in init(); null = no pty available. */
  pty?: PtyFactory | null;
  /** Screen model for the setup-token capture (tests); default is the xterm screen. */
  screen?: ScreenFactory;
  log?: (m: string) => void;
  checkTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Login state of the built-in main account, shown on the Terminal login row (omitted while null). */
  main?: { info(): MainAccountInfo | null };
  /** scrypt cost for profile passwords. Tests only: production always uses the default (32768). */
  scryptN?: number;
}

/** Input of setPassword: `current` verifies (change, remove), `next` is the new password (set, change). */
export interface PasswordChange {
  current?: string;
  next?: string;
}

export interface AccountPatch {
  name?: string;
  color?: string;
  letter?: string;
  note?: string;
  hidden?: boolean;
}

export interface AccountCreate {
  name: string;
  color?: string;
  letter?: string;
  note?: string;
}

export const TERMINAL_NAME = 'Main account';
const TERMINAL_HIDDEN_KEY = 'terminal_hidden';
const TERMINAL_USAGE_KEY = 'terminal_usage';
const DEFAULT_KEY = 'default';
const SECRET_PREFIX = 'account:';
const CHECK_ARGS = [
  '-p',
  '--model',
  'haiku',
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  '',
  '--no-session-persistence',
  '--output-format',
  'stream-json',
  '--verbose',
  'reply ok',
];
const CHECK_OUT_CAP = 200 * 1024;
/** A profile's stored usage younger than this is served from the db by refreshUsage, without a check run. */
const REFRESH_USAGE_MS = 10 * 60_000;
const USAGE_EMIT_MS = 2000;
const SESSION_KEEP_MS = 90 * 24 * 3600_000;
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 600_000;
/** Wrong password tries in a row before a profile refuses further tries for TRY_LOCK_MS. */
const MAX_TRIES = 5;
const TRY_LOCK_MS = 30_000;
const LOCKED_MESSAGE = 'โปรไฟล์นี้ถูกล็อก — ใส่รหัสผ่านเพื่อปลดล็อก';

export type AccountErrorCode =
  | 'NAME_INVALID'
  | 'COLOR_INVALID'
  | 'LETTER_INVALID'
  | 'NOTE_INVALID'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'BUILTIN'
  | 'TOKEN_INVALID'
  | 'PTY_UNAVAILABLE'
  | 'CONNECT_BUSY'
  | 'SECRETS_UNAVAILABLE'
  | 'ACCOUNT_NO_TOKEN'
  | 'BAD_PASSWORD'
  | 'TOO_MANY_TRIES'
  | 'PROFILE_LOCKED'
  | 'PASSWORD_INVALID'
  | 'NO_PASSWORD'
  | 'LOGIN_BUSY'
  | 'NO_LOGIN_RUNNING'
  | 'CODE_INVALID'
  | 'BUSY_JOBS'
  | 'LOCKED'
  | 'NOT_LOGGED_IN';

/** Error with a stable `srvCode` (the API and ws layers read it through codeOf()). Messages never carry a token. */
function fail(code: AccountErrorCode, message: string): CodedError {
  return new CodedError(message, code);
}

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as unknown as ChildLike;

function fingerprintOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

/** Slug of a profile name: lowercase a-z0-9, runs of anything else become '-', at most 40 chars. '' when nothing is left. */
function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** Next colour: starting at rows.length (mod n), the first colour no profile uses yet; all used -> the start colour. */
function nextColor(rows: AccountRow[]): string {
  const n = ACCOUNT_COLORS.length;
  const start = rows.length % n;
  const used = new Set(rows.map((r) => r.color));
  for (let i = 0; i < n; i++) {
    const c = ACCOUNT_COLORS[(start + i) % n];
    if (!used.has(c)) return c;
  }
  return ACCOUNT_COLORS[start];
}

function parseUsage(raw: string | null): AccountUsage | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (typeof (v as Record<string, unknown>).updatedAt !== 'number') return null;
    return v as AccountUsage;
  } catch {
    return null;
  }
}

/** True when a `claude -p --output-format json` stdout is one JSON object that does not report an error. */
function checkOutputOk(out: string): boolean {
  try {
    const v: unknown = JSON.parse(out.trim());
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    return (v as Record<string, unknown>).is_error !== true;
  } catch {
    return false;
  }
}

/**
 * Reads a `claude -p --output-format stream-json` stdout (JSON lines). ok: a `result` line exists and does not report
 * is_error (no result line: the legacy single-object form is judged by checkOutputOk). rateEvents: every
 * rate_limit_event line, in order. Nothing else from the output is kept.
 */
function parseCheckOutput(out: string): { ok: boolean; rateEvents: unknown[] } {
  const rateEvents: unknown[] = [];
  let result: Record<string, unknown> | null = null;
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const type = (v as Record<string, unknown>).type;
    if (type === 'rate_limit_event') rateEvents.push(v);
    else if (type === 'result') result = v as Record<string, unknown>;
  }
  if (result) return { ok: result.is_error !== true, rateEvents };
  // A stream without a result line is never ok; only a legacy single object that is not a stream event can be.
  if (rateEvents.length > 0) return { ok: false, rateEvents };
  return { ok: checkOutputOk(out), rateEvents };
}

interface ConnectRun {
  accountId: string;
  cancel: () => void;
}

interface UsageEmit {
  last: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface TryState {
  count: number;
  lockedUntil: number;
}

export class AccountService extends EventEmitter implements AccountPort {
  private readonly deps: AccountServiceDeps;
  private readonly now: () => number;
  private readonly spawnFn: SpawnFn;
  /** Loaded plaintext tokens. A locked profile has no entry here. */
  private readonly tokens = new Map<string, string>();
  /** Profiles whose stored token is a password envelope (passworded), locked or not. */
  private readonly passworded = new Set<string>();
  /** The stored envelope of a passworded profile. Encrypted only: never a token or a password. */
  private readonly envelopes = new Map<string, string>();
  /** Wrong-password tries per profile (in memory, reset by a success). */
  private readonly tries = new Map<string, TryState>();
  private readonly checks = new Map<string, Promise<AccountInfo>>();
  private readonly usageEmit = new Map<string, UsageEmit>();
  private ptyFactory: PtyFactory | null | undefined;
  private connecting: ConnectRun | null = null;
  /** Every pending timer this service started; dispose() clears them all. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Aborts of the `claude -p` runs in flight: each kills its child and settles its check as failed. */
  private readonly runningChecks = new Set<() => void>();
  private disposed = false;

  constructor(deps: AccountServiceDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.ptyFactory = deps.pty;
  }

  // ---- lifecycle ----

  /** Loads every token from the secret store and the pty factory. Never throws. */
  async init(): Promise<void> {
    try {
      for (const row of this.deps.db.listAccounts()) {
        if (row.fingerprint === null) continue;
        try {
          const t = await this.deps.secrets.get(SECRET_PREFIX + row.id);
          if (typeof t !== 'string') continue;
          if (isEnvelope(t)) {
            // a passworded profile: the envelope is kept, the token stays out of memory until unlock()
            this.passworded.add(row.id);
            this.envelopes.set(row.id, t);
          } else if (TOKEN_RE.test(t)) {
            this.tokens.set(row.id, t);
          }
        } catch {
          // a failed read leaves the token out: tokenFor() then throws srv.account.noToken
        }
      }
    } catch {
      // database trouble: the list is empty, the service still answers
    }
    if (this.ptyFactory === undefined) {
      try {
        this.ptyFactory = await loadPty();
      } catch {
        this.ptyFactory = null;
      }
    }
    try {
      this.deps.db.pruneSessionAccounts(this.now() - SESSION_KEEP_MS);
    } catch {
      // pruning is housekeeping only
    }
  }

  /**
   * Stops the service: cancels a running connect, kills running checks, clears every pending timer. After this every
   * scheduled emit is a no-op, so a late timer can never touch a closed database. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const st of this.usageEmit.values()) st.timer = undefined;
    this.usageEmit.clear();
    for (const abort of [...this.runningChecks]) {
      try {
        abort();
      } catch {
        // a dead child is already settled
      }
    }
    this.runningChecks.clear();
    try {
      this.cancelConnect();
    } catch {
      // nothing else to stop
    }
  }

  // ---- reads ----

  view(): AccountsView {
    const rows = this.deps.db.listAccounts();
    return {
      accounts: [this.terminalInfo(), ...rows.map((r) => this.toInfo(r))],
      defaultId: this.defaultId(),
      ptyAvailable: this.ptyFactory !== null && this.ptyFactory !== undefined,
    };
  }

  defaultId(): string {
    const v = this.deps.db.getAccountSetting(DEFAULT_KEY);
    if (v && v !== TERMINAL_ACCOUNT_ID && this.deps.db.getAccount(v) !== null) return v;
    return TERMINAL_ACCOUNT_ID;
  }

  exists(id: string): boolean {
    return id === TERMINAL_ACCOUNT_ID || this.deps.db.getAccount(id) !== null;
  }

  nameOf(id: string): string {
    if (id === TERMINAL_ACCOUNT_ID) return TERMINAL_NAME;
    return this.deps.db.getAccount(id)?.name ?? id;
  }

  tokenFor(id: string): string | null {
    if (id === TERMINAL_ACCOUNT_ID) return null;
    if (this.isLocked(id)) throw new CommandError(LOCKED_MESSAGE, 'srv.account.locked');
    const t = this.tokenOf(id);
    if (t === null) throw new CommandError('ยังไม่มี token ของบัญชีนี้ — เชื่อมต่อบัญชีที่หน้า จัดการโปรไฟล์ ก่อน', 'srv.account.noToken');
    return t;
  }

  /** Locked = passworded and not unlocked in this server run (its token is not in memory). */
  isLocked(id: string): boolean {
    return this.passworded.has(id) && !this.tokens.has(id);
  }

  sessionAccount(sessionId: string): string | null {
    return this.deps.db.getSessionAccount(sessionId);
  }

  rememberSession(sessionId: string, accountId: string): void {
    this.deps.db.setSessionAccount(sessionId, accountId, this.now());
  }

  // ---- profile writes ----

  create(input: AccountCreate): AccountInfo {
    const v = validateProfileInput(input, false);
    if (!v.ok) throw fail(v.error as AccountErrorCode, 'Invalid profile');
    const value = v.value;
    const name = value.name ?? '';
    const rows = this.deps.db.listAccounts();
    const id = this.newId(name);
    const row: AccountRow = {
      id,
      name,
      color: value.color ?? nextColor(rows),
      letter: value.letter ?? defaultLetter(name),
      note: value.note ?? '',
      fingerprint: null,
      createdAt: this.now(),
      tokenAt: null,
      lastCheckAt: null,
      lastCheckOk: null,
      lastUsage: null,
      hidden: false,
    };
    this.deps.db.insertAccount(row);
    this.log(`account ${id} created`);
    this.changed();
    return this.toInfo(row);
  }

  patch(id: string, patch: AccountPatch): AccountInfo {
    if (id === TERMINAL_ACCOUNT_ID) {
      const others = (['name', 'color', 'letter', 'note'] as const).some((k) => patch[k] !== undefined);
      if (others) throw fail('BUILTIN', 'The Terminal login profile only takes hidden');
      if (patch.hidden !== undefined) {
        if (typeof patch.hidden !== 'boolean') throw fail('BAD_REQUEST', 'Invalid body');
        this.deps.db.setAccountSetting(TERMINAL_HIDDEN_KEY, patch.hidden ? '1' : '0');
        this.changed();
      }
      return this.terminalInfo();
    }
    const row = this.deps.db.getAccount(id);
    if (!row) throw fail('NOT_FOUND', 'Account not found');
    if (patch.hidden !== undefined && typeof patch.hidden !== 'boolean') throw fail('BAD_REQUEST', 'Invalid body');
    const v = validateProfileInput(patch, true);
    if (!v.ok) throw fail(v.error as AccountErrorCode, 'Invalid profile');
    const upd: Partial<Omit<AccountRow, 'id' | 'createdAt'>> = {};
    if (v.value.name !== undefined) upd.name = v.value.name;
    if (v.value.color !== undefined) upd.color = v.value.color;
    if (v.value.letter !== undefined) upd.letter = v.value.letter;
    if (v.value.note !== undefined) upd.note = v.value.note;
    if (patch.hidden !== undefined) upd.hidden = patch.hidden;
    this.deps.db.updateAccount(id, upd);
    this.log(`account ${id} updated`);
    this.changed();
    const after = this.deps.db.getAccount(id);
    if (!after) throw fail('NOT_FOUND', 'Account not found');
    return this.toInfo(after);
  }

  async remove(id: string): Promise<void> {
    if (id === TERMINAL_ACCOUNT_ID) throw fail('BUILTIN', 'The Terminal login profile cannot be removed');
    if (!this.deps.db.getAccount(id)) throw fail('NOT_FOUND', 'Account not found');
    try {
      await this.deps.secrets.clear(SECRET_PREFIX + id);
    } catch {
      // the row goes anyway; a stale secret is cleared by the next remove or by hand
    }
    this.tokens.delete(id);
    this.passworded.delete(id);
    this.envelopes.delete(id);
    this.tries.delete(id);
    this.deps.db.deleteAccount(id);
    if (this.deps.db.getAccountSetting(DEFAULT_KEY) === id) this.deps.db.setAccountSetting(DEFAULT_KEY, TERMINAL_ACCOUNT_ID);
    this.log(`account ${id} removed`);
    this.changed();
  }

  setDefault(id: string): void {
    if (!this.exists(id)) throw fail('NOT_FOUND', 'Account not found');
    this.deps.db.setAccountSetting(DEFAULT_KEY, id);
    this.changed();
  }

  // ---- token and health check ----

  async putToken(id: string, token: string): Promise<AccountInfo> {
    if (id === TERMINAL_ACCOUNT_ID) throw fail('BUILTIN', 'The Terminal login profile has no token');
    if (!this.deps.db.getAccount(id)) throw fail('NOT_FOUND', 'Account not found');
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw fail('TOKEN_INVALID', 'Token format is invalid');
    await this.saveToken(id, token);
    return this.check(id);
  }

  /** Runs `claude -p` as the profile (token in the child env only). Concurrent calls for one profile share one run. */
  check(id: string): Promise<AccountInfo> {
    if (id === TERMINAL_ACCOUNT_ID) return Promise.reject(fail('BUILTIN', 'The Terminal login profile has no check'));
    const row = this.deps.db.getAccount(id);
    if (!row) return Promise.reject(fail('NOT_FOUND', 'Account not found'));
    // a locked profile spawns nothing: the stored view is returned as it is
    if (this.isLocked(id)) return Promise.resolve(this.toInfo(row));
    const token = this.tokenOf(id);
    if (token === null) return Promise.reject(fail('ACCOUNT_NO_TOKEN', 'Account has no token loaded'));
    const running = this.checks.get(id);
    if (running) return running;
    const flight = (async (): Promise<AccountInfo> => {
      try {
        const ok = await this.runCheck(id, token);
        const at = this.now();
        if (!this.deps.db.updateAccount(id, { lastCheckAt: at, lastCheckOk: ok })) throw fail('NOT_FOUND', 'Account not found');
        this.log(`account ${id} check ${ok ? 'ok' : 'failed'}`);
        this.changed();
        const row = this.deps.db.getAccount(id);
        if (!row) throw fail('NOT_FOUND', 'Account not found');
        return this.toInfo(row);
      } finally {
        this.checks.delete(id);
      }
    })();
    this.checks.set(id, flight);
    return flight;
  }

  // ---- passwords ----

  /**
   * Decrypts a passworded profile with `password` and loads its token. Wrong password: BAD_PASSWORD; after MAX_TRIES
   * wrong tries in a row the profile refuses for TRY_LOCK_MS (TOO_MANY_TRIES). Emits 'unlocked' on success.
   */
  async unlock(id: string, password: string): Promise<AccountInfo> {
    if (id === TERMINAL_ACCOUNT_ID) throw fail('BUILTIN', 'The Terminal login profile has no password');
    const row = this.deps.db.getAccount(id);
    if (!row) throw fail('NOT_FOUND', 'Account not found');
    if (typeof password !== 'string') throw fail('BAD_REQUEST', 'Invalid body');
    if (!this.passworded.has(id)) throw fail('NO_PASSWORD', 'Account has no password');
    if (!this.isLocked(id)) return this.toInfo(row);
    const token = this.verify(id, password);
    this.tokens.set(id, token);
    this.log(`account ${id} unlocked`);
    this.emit('unlocked', id);
    this.changed();
    return this.toInfo(row);
  }

  /**
   * Sets, changes or removes the profile password. set: `next` only (token loaded, no password yet). change: `current`
   * and `next`. remove: `current` only. The secret store is written first; memory changes only after it succeeded.
   */
  async setPassword(id: string, input: PasswordChange): Promise<AccountInfo> {
    if (id === TERMINAL_ACCOUNT_ID) throw fail('BUILTIN', 'The Terminal login profile has no password');
    const row = this.deps.db.getAccount(id);
    if (!row) throw fail('NOT_FOUND', 'Account not found');
    const hasCur = input.current !== undefined;
    const hasNext = input.next !== undefined;
    if ((hasCur && typeof input.current !== 'string') || (hasNext && typeof input.next !== 'string')) throw fail('BAD_REQUEST', 'Invalid body');
    if (!hasCur && !hasNext) throw fail('BAD_REQUEST', 'Nothing to change');
    if (hasNext && !validatePassword(input.next)) throw fail('PASSWORD_INVALID', 'Password length is invalid');
    if (row.fingerprint === null) throw fail('ACCOUNT_NO_TOKEN', 'Account has no token loaded');

    if (!this.passworded.has(id)) {
      // no password yet: only `set` makes sense
      if (hasCur) throw fail('NO_PASSWORD', 'Account has no password');
      const token = this.tokens.get(id);
      if (token === undefined) throw fail('ACCOUNT_NO_TOKEN', 'Account has no token loaded');
      const envelope = encryptToken(token, input.next as string, this.encryptOpts());
      await this.storePasswordValue(id, envelope);
      this.envelopes.set(id, envelope);
      this.passworded.add(id);
      this.log(`account ${id} password set`);
      this.changed();
      return this.toInfo(row);
    }

    // passworded: change or remove both need the current password
    if (!hasCur) throw fail(this.isLocked(id) ? 'PROFILE_LOCKED' : 'BAD_PASSWORD', 'Current password is required');
    const token = this.verify(id, input.current as string);
    if (hasNext) {
      const envelope = encryptToken(token, input.next as string, this.encryptOpts());
      await this.storePasswordValue(id, envelope);
      this.envelopes.set(id, envelope);
      this.tokens.set(id, token);
      this.log(`account ${id} password changed`);
    } else {
      await this.storePasswordValue(id, token);
      this.passworded.delete(id);
      this.envelopes.delete(id);
      this.tokens.set(id, token);
      this.log(`account ${id} password removed`);
    }
    this.changed();
    return this.toInfo(row);
  }

  /** Decrypts the stored envelope with `password`. Counts the try; refuses with TOO_MANY_TRIES while locked out. */
  private verify(id: string, password: string): string {
    const state = this.tries.get(id);
    if (state && state.lockedUntil > this.now()) throw fail('TOO_MANY_TRIES', 'Too many wrong passwords, wait and try again');
    const envelope = this.envelopes.get(id);
    const token = envelope === undefined ? null : decryptToken(envelope, password);
    if (token === null) {
      const next: TryState = state ?? { count: 0, lockedUntil: 0 };
      next.count++;
      if (next.count >= MAX_TRIES) {
        next.count = 0;
        next.lockedUntil = this.now() + TRY_LOCK_MS;
      }
      this.tries.set(id, next);
      throw fail('BAD_PASSWORD', 'Wrong password');
    }
    this.tries.delete(id);
    return token;
  }

  /** Writes a secret value for a profile (envelope or raw token). SECRETS_UNAVAILABLE when the store refuses. */
  private async storePasswordValue(id: string, value: string): Promise<void> {
    try {
      await this.deps.secrets.set(SECRET_PREFIX + id, value);
    } catch {
      throw fail('SECRETS_UNAVAILABLE', 'The secret store is not available');
    }
  }

  private encryptOpts(): { N?: number } | undefined {
    return this.deps.scryptN !== undefined ? { N: this.deps.scryptN } : undefined;
  }

  // ---- setup-token capture ----

  /** Starts `claude setup-token` in a pty. Progress arrives as 'connect' events. Throws before starting when it cannot. */
  connect(id: string): void {
    if (id === TERMINAL_ACCOUNT_ID) throw fail('BUILTIN', 'The Terminal login profile has no token to capture');
    if (!this.deps.db.getAccount(id)) throw fail('NOT_FOUND', 'Account not found');
    const factory = this.ptyFactory;
    if (!factory) throw fail('PTY_UNAVAILABLE', 'No pseudo-console available on this machine');
    if (this.connecting) throw fail('CONNECT_BUSY', 'A connect is already running');

    const run: ConnectRun = { accountId: id, cancel: () => undefined };
    this.connecting = run;
    let handle: ReturnType<typeof startSetupToken>;
    try {
      handle = startSetupToken({
        pty: factory,
        ...(this.deps.screen ? { screen: this.deps.screen } : {}),
        bin: this.setupBin(),
        cwd: os.tmpdir(),
        env: this.connectEnv(),
        timeoutMs: this.deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        onStatus: (s) => {
          if (s.status === 'waiting_browser') this.connectEvent({ accountId: id, status: 'waiting_browser', ...(s.url ? { url: s.url } : {}) });
          else this.connectEvent({ accountId: id, status: 'captured' });
        },
      });
    } catch {
      if (this.connecting === run) this.connecting = null;
      throw fail('PTY_UNAVAILABLE', 'The pseudo-console did not start');
    }
    run.cancel = () => handle.cancel();
    this.log(`connect ${id} started`);
    handle.done
      .then(
        (r) => this.finishConnect(run, r),
        () => this.finishConnect(run, { ok: false, error: 'failed' }),
      )
      .catch(() => undefined);
  }

  /** Kills the running capture by its pid. True when one was running. */
  cancelConnect(): boolean {
    const run = this.connecting;
    if (!run) return false;
    try {
      run.cancel();
    } catch {
      // already gone
    }
    return true;
  }

  // ---- usage ----

  /** Merges a stream `rate_limit_event` into the profile's last usage. Persists every time, emits at most every 2 s. */
  recordUsage(accountId: string, streamEvent: unknown): void {
    if (this.disposed) return;
    if (!streamEvent || typeof streamEvent !== 'object') return;
    if ((streamEvent as { type?: unknown }).type !== 'rate_limit_event') return;
    const isTerminal = accountId === TERMINAL_ACCOUNT_ID;
    const row = isTerminal ? null : this.deps.db.getAccount(accountId);
    if (!isTerminal && !row) return;
    const now = this.now();
    const parsed = parseRateLimitEvent(streamEvent, null, now);
    if (!parsed.fiveHour && !parsed.sevenDay) return;
    const prev = isTerminal ? parseUsage(this.deps.db.getAccountSetting(TERMINAL_USAGE_KEY)) : (row?.lastUsage ?? null);
    const win = (q: { pct: number; resetsAt: number | null } | null) => (q ? { pct: q.pct, resetsAt: q.resetsAt } : null);
    const usage: AccountUsage = {
      fiveHour: win(parsed.fiveHour) ?? prev?.fiveHour ?? null,
      sevenDay: win(parsed.sevenDay) ?? prev?.sevenDay ?? null,
      updatedAt: now,
    };
    if (isTerminal) this.deps.db.setAccountSetting(TERMINAL_USAGE_KEY, JSON.stringify(usage));
    else this.deps.db.updateAccount(accountId, { lastUsage: usage });
    this.scheduleUsageEmit(accountId);
  }

  // ---- internals ----

  private log(m: string): void {
    try {
      this.deps.log?.(m);
    } catch {
      // logging never breaks a profile action
    }
  }

  private changed(): void {
    if (this.disposed) return;
    this.emit('change', this.view());
  }

  /** Re-emits 'change' with the current view (e.g. the main account's status moved). No-op after dispose(). */
  notifyChanged(): void {
    this.changed();
  }

  private connectEvent(ev: ConnectEvent): void {
    if (this.disposed) return;
    this.emit('connect', ev);
  }

  /** A timer that runs `fn` once, unless the service is disposed. The callback never throws out of the timer. */
  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> | null {
    if (this.disposed) return null;
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        fn();
      } catch {
        // a late fire after close must never surface as an unhandled error
      }
    }, ms);
    t.unref?.();
    this.timers.add(t);
    return t;
  }

  private terminalInfo(): AccountInfo {
    const main = this.deps.main?.info() ?? null;
    return {
      id: TERMINAL_ACCOUNT_ID,
      name: TERMINAL_NAME,
      color: ACCOUNT_COLORS[4],
      letter: 'T',
      note: '',
      builtin: true,
      tokenState: 'unset',
      fingerprint: null,
      createdAt: 0,
      tokenAt: null,
      expiresAt: null,
      lastCheckAt: null,
      lastCheckOk: null,
      usage: parseUsage(this.deps.db.getAccountSetting(TERMINAL_USAGE_KEY)),
      hidden: this.deps.db.getAccountSetting(TERMINAL_HIDDEN_KEY) === '1',
      locked: false,
      hasPassword: false,
      ...(main ? { main } : {}),
    };
  }

  private toInfo(row: AccountRow): AccountInfo {
    const hasToken = row.fingerprint !== null;
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      letter: row.letter,
      note: row.note,
      builtin: false,
      tokenState: hasToken ? 'set' : 'unset',
      fingerprint: row.fingerprint,
      createdAt: row.createdAt,
      tokenAt: row.tokenAt,
      expiresAt: hasToken && row.tokenAt !== null ? row.tokenAt + TOKEN_LIFETIME_MS : null,
      lastCheckAt: row.lastCheckAt,
      lastCheckOk: row.lastCheckOk,
      usage: row.lastUsage,
      hidden: row.hidden,
      locked: this.isLocked(row.id),
      hasPassword: this.passworded.has(row.id),
    };
  }

  /** The loaded token of a row, or null when the row has none or it is not in memory. */
  private tokenOf(id: string): string | null {
    const row = this.deps.db.getAccount(id);
    if (!row || row.fingerprint === null) return null;
    return this.tokens.get(id) ?? null;
  }

  private newId(name: string): string {
    const base = slugOf(name) || 'a-' + randomBytes(3).toString('hex');
    let id = base;
    let n = 2;
    while (RESERVED_ACCOUNT_IDS.includes(id) || !ACCOUNT_ID_RE.test(id) || this.deps.db.getAccount(id) !== null) {
      id = `${base}-${n++}`;
    }
    return id;
  }

  /** Stores a token: secret store first, then memory, fingerprint and tokenAt. Never logs the token. */
  private async saveToken(id: string, token: string): Promise<void> {
    try {
      await this.deps.secrets.set(SECRET_PREFIX + id, token);
    } catch {
      throw fail('SECRETS_UNAVAILABLE', 'The secret store is not available');
    }
    // a new raw token replaces the old envelope: the profile is no longer passworded (forgot-password path)
    this.passworded.delete(id);
    this.envelopes.delete(id);
    this.tries.delete(id);
    this.tokens.set(id, token);
    if (!this.deps.db.updateAccount(id, { fingerprint: fingerprintOf(token), tokenAt: this.now() })) {
      this.tokens.delete(id);
      // The row is gone (deleted during the connect): drop the secret stored above so it is not left behind.
      try {
        await this.deps.secrets.clear(SECRET_PREFIX + id);
      } catch {
        // swallowed: the NOT_FOUND below is the answer the caller needs
      }
      throw fail('NOT_FOUND', 'Account not found');
    }
    this.log(`account ${id} token saved`);
    this.changed();
  }

  private async finishConnect(run: ConnectRun, r: SetupTokenResult): Promise<void> {
    const id = run.accountId;
    if (this.disposed) {
      // a capture that ends after dispose() saves nothing and emits nothing
      if (this.connecting === run) this.connecting = null;
      return;
    }
    try {
      if (!r.ok) {
        const status = r.error === 'timeout' ? 'timeout' : r.error === 'cancelled' ? 'cancelled' : 'failed';
        this.log(`connect ${id} ${status}`);
        this.connectEvent(status === 'failed' ? { accountId: id, status, error: 'CONNECT_FAILED' } : { accountId: id, status });
        return;
      }
      if (!TOKEN_RE.test(r.token)) {
        this.connectEvent({ accountId: id, status: 'failed', error: 'TOKEN_INVALID' });
        return;
      }
      this.connectEvent({ accountId: id, status: 'checking' });
      try {
        await this.saveToken(id, r.token);
      } catch (e) {
        const code = e instanceof CodedError && e.srvCode ? e.srvCode : 'SECRETS_UNAVAILABLE';
        this.connectEvent({ accountId: id, status: 'failed', error: code });
        return;
      }
      let checkOk = false;
      try {
        checkOk = (await this.check(id)).lastCheckOk === true;
      } catch {
        checkOk = false;
      }
      this.log(`connect ${id} done`);
      this.connectEvent({ accountId: id, status: 'done', checkOk });
    } catch {
      this.connectEvent({ accountId: id, status: 'failed', error: 'CONNECT_FAILED' });
    } finally {
      if (this.connecting === run) this.connecting = null;
    }
  }

  private setupBin(): string {
    return this.deps.claudeBin ?? process.env.CR_CLAUDE_BIN ?? (process.platform === 'win32' ? 'claude.exe' : 'claude');
  }

  private checkBin(): string {
    return this.deps.claudeBin ?? process.env.CR_CLAUDE_BIN ?? 'claude';
  }

  /** Env for the setup-token pty: no CLAUDE* (childEnv) and no API keys that would override the login being created. */
  private connectEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(childEnv())) {
      if (typeof v !== 'string') continue;
      if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') continue;
      env[k] = v;
    }
    return env;
  }

  /**
   * Fresh usage for the profile: the stored one when it is younger than 10 min (no process spawned), else one check run
   * (which also records the rate_limit_event lines it prints). Concurrent calls share one run via check().
   */
  async refreshUsage(id: string): Promise<AccountInfo> {
    if (id === TERMINAL_ACCOUNT_ID) throw fail('BUILTIN', 'The Terminal login profile has no usage refresh');
    const row = this.deps.db.getAccount(id);
    if (!row) throw fail('NOT_FOUND', 'Account not found');
    if (this.isLocked(id)) return this.toInfo(row);
    if (this.tokenOf(id) === null) throw fail('ACCOUNT_NO_TOKEN', 'Account has no token loaded');
    if (row.lastUsage && this.now() - row.lastUsage.updatedAt < REFRESH_USAGE_MS) return this.toInfo(row);
    return this.check(id);
  }

  /** One `claude -p` run as the profile. Resolves true only for exit 0 and a result that does not report is_error. Never throws. */
  private runCheck(accountId: string, token: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | null = null;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abort) this.runningChecks.delete(abort);
        resolve(ok);
      };
      const env: NodeJS.ProcessEnv = childEnv();
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;

      let child: ChildLike;
      try {
        child = this.spawnFn(this.checkBin(), [...CHECK_ARGS], { cwd: os.tmpdir(), env });
      } catch {
        finish(false);
        return;
      }
      // dispose() aborts a run in flight: kill the child, settle as failed (the timer is cleared by finish)
      abort = (): void => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(false);
      };
      this.runningChecks.add(abort);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      child.stdout.on('data', (d: Buffer | string) => {
        const b = typeof d === 'string' ? Buffer.from(d) : d;
        if (truncated) return;
        bytes += b.length;
        if (bytes > CHECK_OUT_CAP) {
          truncated = true;
          return;
        }
        chunks.push(b);
      });
      // stderr is drained and discarded: it is never stored or logged
      child.stderr?.on('data', () => undefined);
      child.stdin.on('error', () => undefined);
      child.on('error', () => finish(false));
      child.on('close', (code: number | null) => {
        const out = Buffer.concat(chunks).toString('utf8');
        const parsed = truncated ? null : parseCheckOutput(out);
        if (parsed) {
          for (const ev of parsed.rateEvents) {
            try {
              this.recordUsage(accountId, ev);
            } catch {
              // usage is a side record: a failure here never fails the check
            }
          }
        }
        finish(code === 0 && parsed !== null && parsed.ok);
      });
      try {
        child.stdin.end();
      } catch {
        // the child reads nothing from stdin
      }
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already gone
        }
        finish(false);
      }, this.deps.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS);
    });
  }

  /** At most one 'change' per 2 s per profile; a trailing emit carries the latest state. */
  private scheduleUsageEmit(id: string): void {
    if (this.disposed) return;
    const now = this.now();
    let st = this.usageEmit.get(id);
    if (!st) {
      st = { last: 0 };
      this.usageEmit.set(id, st);
    }
    if (st.timer) return;
    const wait = st.last + USAGE_EMIT_MS - now;
    if (wait <= 0) {
      st.last = now;
      this.changed();
      return;
    }
    const entry = st;
    entry.timer = this.later(wait, () => {
      entry.timer = undefined;
      entry.last = this.now();
      this.changed();
    }) ?? undefined;
  }
}
