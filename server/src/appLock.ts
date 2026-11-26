// Optional app lock: one 6-digit PIN (scrypt verifier in config.json) that gates the whole web UI and its API.
// The PIN is never stored, logged or echoed. Sessions live only in this process's memory, so a restart
// locks the app again. With no PIN set, everything is allowed.
import crypto from 'node:crypto';
import type http from 'node:http';
import { validatePin } from '../../shared/accounts';
import { dataDir } from './cmdlog';
import { loadAppLock, saveAppLock, type AppLockRecord } from './config';

export const SESSION_COOKIE = 'cr_session';
const KEY_LEN = 32;
const SALT_LEN = 16;
const SID_BYTES = 32;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MAX_TRIES = 5;
/** Lockout for each block of MAX_TRIES wrong PINs: 30 s, 2 min, 10 min, then 30 min for every later block. */
export const LOCK_STEPS_MS: readonly number[] = [30_000, 120_000, 600_000, 1_800_000];
/** Retry hint when a parallel guess is still being checked (no lockout yet). */
export const IN_FLIGHT_RETRY_MS = 1_000;
const MAX_SESSIONS = 100;

export type VerifyResult = 'ok' | 'bad' | 'wait';

/** Error with a fixed code only. The message never carries the PIN. retryAfterMs is set for TOO_MANY_TRIES. */
export class AppLockError extends Error {
  constructor(
    readonly code: 'PIN_INVALID' | 'BAD_PASSWORD' | 'TOO_MANY_TRIES' | 'NO_PASSWORD',
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

export interface AppLockOptions {
  dir?: string;
  now?: () => number;
  randomBytes?: (n: number) => Buffer;
  /** scrypt cost. Tests only: production always uses the default. */
  N?: number;
}

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Pulls the session id out of a Cookie header. Returns undefined when the cookie is absent. */
function sessionIdOf(cookieHeader: string | undefined): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) return trimmed.slice(SESSION_COOKIE.length + 1);
  }
  return undefined;
}

export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export class AppLock {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly rand: (n: number) => Buffer;
  private readonly N: number;
  private record: AppLockRecord | null;
  private readonly sessions = new Set<string>();
  private fails = 0; // wrong PINs in the current block of MAX_TRIES
  private inFlight = 0; // PIN checks admitted and not yet answered
  private lockedUntil = 0;
  private blocks = 0; // lockouts started since the last correct PIN (or since this instance started)

  constructor(opts: AppLockOptions = {}) {
    this.dir = opts.dir ?? dataDir();
    this.now = opts.now ?? Date.now;
    this.rand = opts.randomBytes ?? ((n: number) => crypto.randomBytes(n));
    this.N = opts.N ?? SCRYPT_N;
    this.record = loadAppLock(this.dir);
  }

  configured(): boolean {
    return this.record !== null;
  }

  /** Milliseconds left in the current lockout, 0 when not locked. */
  retryAfterMs(): number {
    const left = this.lockedUntil - this.now();
    return left > 0 ? left : 0;
  }

  /** Starts the lockout for the next block: its length comes from how many blocks came before it. */
  private startLockout(): void {
    const step = LOCK_STEPS_MS[Math.min(this.blocks, LOCK_STEPS_MS.length - 1)];
    this.blocks++;
    this.lockedUntil = this.now() + step;
    this.fails = 0;
  }

  /**
   * ok when the PIN matches, bad when it does not, wait while a lockout runs (scrypt is not touched then) or
   * while MAX_TRIES checks are already in flight. A PIN that is not 6 digits throws PIN_INVALID before anything
   * else and does not count as a try.
   */
  async verify(pin: string): Promise<VerifyResult> {
    if (!validatePin(pin)) throw new AppLockError('PIN_INVALID');
    const rec = this.record;
    if (!rec) return 'bad';
    if (this.retryAfterMs() > 0 || this.fails + this.inFlight >= MAX_TRIES) return 'wait';
    this.inFlight++;
    let key: Buffer;
    try {
      key = await scryptAsync(pin, Buffer.from(rec.salt, 'base64'), rec.N, rec.r, rec.p);
    } finally {
      this.inFlight--;
    }
    const stored = Buffer.from(rec.hash, 'base64');
    if (crypto.timingSafeEqual(key, stored)) {
      this.fails = 0;
      this.blocks = 0;
      this.lockedUntil = 0;
      return 'ok';
    }
    this.fails++;
    if (this.fails >= MAX_TRIES) this.startLockout();
    return 'bad';
  }

  private tooManyTries(): AppLockError {
    return new AppLockError('TOO_MANY_TRIES', Math.max(this.retryAfterMs(), IN_FLIGHT_RETRY_MS));
  }

  /** Checks the current PIN before a change or removal. Throws AppLockError on any failure. */
  private async requireCurrent(current: unknown): Promise<void> {
    if (!validatePin(current)) throw new AppLockError('PIN_INVALID');
    const r = await this.verify(current);
    if (r === 'wait') throw this.tooManyTries();
    if (r !== 'ok') throw new AppLockError('BAD_PASSWORD');
  }

  /** Sets the first PIN, or changes it (then `current` must verify). Clears every session. */
  async set(next: string, current?: string): Promise<void> {
    if (!validatePin(next)) throw new AppLockError('PIN_INVALID');
    if (this.record) await this.requireCurrent(current);
    const salt = this.rand(SALT_LEN);
    const key = await scryptAsync(next, salt, this.N, SCRYPT_R, SCRYPT_P);
    const rec: AppLockRecord = {
      v: 1,
      kdf: 'scrypt',
      N: this.N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: salt.toString('base64'),
      hash: key.toString('base64'),
    };
    saveAppLock(this.dir, rec);
    this.record = rec;
    this.resetSessions();
  }

  /** Removes the PIN. `current` must verify. Clears every session. */
  async remove(current?: string): Promise<void> {
    if (!this.record) throw new AppLockError('NO_PASSWORD');
    await this.requireCurrent(current);
    saveAppLock(this.dir, null);
    this.record = null;
    this.resetSessions();
  }

  /** Clears every session and the throttle (tier included): called after a verified set() or remove(). */
  private resetSessions(): void {
    this.sessions.clear();
    this.fails = 0;
    this.lockedUntil = 0;
    this.blocks = 0;
  }

  /** New session id. Kept in memory only, capped at MAX_SESSIONS (the oldest one goes first). */
  createSession(): string {
    const sid = this.rand(SID_BYTES).toString('hex');
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.values().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }
    this.sessions.add(sid);
    return sid;
  }

  hasSession(cookieHeader: string | undefined): boolean {
    const sid = sessionIdOf(cookieHeader);
    return sid !== undefined && this.sessions.has(sid);
  }

  /** Forgets the session named in the cookie (used by logout). */
  dropSession(cookieHeader: string | undefined): void {
    const sid = sessionIdOf(cookieHeader);
    if (sid !== undefined) this.sessions.delete(sid);
  }

  /** Set-Cookie value. Deliberately no Max-Age or Expires: the cookie lives as long as the browser session. */
  cookieHeader(sid: string): string {
    return `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`;
  }

  /** Set-Cookie value that clears the cookie in the browser. */
  clearCookieHeader(): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  /**
   * Gate for every HTTP request. Returns true when it answered the request (401 LOCKED), false when the
   * request may go on to its handler.
   */
  guard(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.configured()) return false;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const m = req.method ?? 'GET';
    if (p === '/api/auth' || p.startsWith('/api/auth/')) {
      // Preflight and the three calls that work without a session. Everything else under /api/auth needs one.
      if (m === 'OPTIONS') return false;
      if (m === 'GET' && p === '/api/auth/state') return false;
      if (m === 'POST' && p === '/api/auth/unlock') return false;
    } else if (m === 'GET' && p === '/health') {
      return false;
    } else if (!isApiPath(p) && (m === 'GET' || m === 'HEAD')) {
      // Static assets and the SPA index. The API behind them is still locked.
      return false;
    }
    if (this.hasSession(req.headers.cookie)) return false;
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'LOCKED' }));
    return true;
  }

  /** WebSocket upgrade check: with a password set, only a request carrying a live session may connect. */
  wsAllowed(req: http.IncomingMessage): boolean {
    if (!this.configured()) return true;
    return this.hasSession(req.headers.cookie);
  }
}
