import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLock, AppLockError } from '../src/appLock';
import { configFile, loadAppLock } from '../src/config';

// Fake PINs only. Never a real credential.
const PW = '482913';
const PW2 = '705116';
const WRONG = '135790';

// Tests use a small scrypt cost. Production always uses N=32768 (the constructor option is tests only).
const TEST_N = 1024;

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-applock-'));
  tmp.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeLock(dir: string, c = clock()) {
  return new AppLock({ dir, N: TEST_N, now: c.now });
}

/** Minimal req/res doubles for guard() and handler checks. */
function fakeReq(method: string, url: string, cookie?: string): http.IncomingMessage {
  return { method, url, headers: cookie === undefined ? {} : { cookie } } as unknown as http.IncomingMessage;
}

function fakeRes() {
  const out: { status?: number; body?: string; headers?: Record<string, string> } = {};
  const res = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end: (body?: string) => {
      out.body = body;
    },
  };
  return { res: res as unknown as http.ServerResponse, out };
}

describe('AppLock set / verify / remove', () => {
  it('is not configured on an empty dir, and verify is refused', async () => {
    const lock = makeLock(tmpDir());
    expect(lock.configured()).toBe(false);
    expect(await lock.verify(PW)).toBe('bad');
  });

  it('set stores a password, verify accepts it and rejects a wrong one', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    expect(lock.configured()).toBe(true);
    expect(await lock.verify(PW)).toBe('ok');
    expect(await lock.verify(WRONG)).toBe('bad');
  });

  it('a new instance on the same dir reads the stored verifier', async () => {
    const dir = tmpDir();
    await makeLock(dir).set(PW);
    const again = makeLock(dir);
    expect(again.configured()).toBe(true);
    expect(await again.verify(PW)).toBe('ok');
  });

  it('set validates the PIN and refuses a malformed one with PIN_INVALID', async () => {
    const lock = makeLock(tmpDir());
    await expect(lock.set('abc')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    expect(lock.configured()).toBe(false);
  });

  it('change needs the current password; a wrong current gives BAD_PASSWORD and keeps the old one', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    await expect(lock.set(PW2, WRONG)).rejects.toBeInstanceOf(AppLockError);
    await expect(lock.set(PW2)).rejects.toMatchObject({ code: 'PIN_INVALID' });
    expect(await lock.verify(PW)).toBe('ok');
    await lock.set(PW2, PW);
    expect(await lock.verify(PW2)).toBe('ok');
    expect(await lock.verify(PW)).toBe('bad');
  });

  it('remove needs the current password and clears the lock', async () => {
    const dir = tmpDir();
    const lock = makeLock(dir);
    await lock.set(PW);
    await expect(lock.remove(WRONG)).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    expect(lock.configured()).toBe(true);
    await lock.remove(PW);
    expect(lock.configured()).toBe(false);
    expect(loadAppLock(dir)).toBeNull();
    await expect(lock.remove(PW)).rejects.toMatchObject({ code: 'NO_PASSWORD' });
  });

  it('set and remove clear every session', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    const sid = lock.createSession();
    expect(lock.hasSession(lock.cookieHeader(sid))).toBe(true);
    await lock.set(PW2, PW);
    expect(lock.hasSession(lock.cookieHeader(sid))).toBe(false);
    const sid2 = lock.createSession();
    await lock.remove(PW2);
    expect(lock.hasSession(lock.cookieHeader(sid2))).toBe(false);
  });
});

describe('wrong-try throttle', () => {
  it('5 wrong tries give wait for 30 s (injected clock), then the right password works again', async () => {
    const c = clock();
    const lock = makeLock(tmpDir(), c);
    await lock.set(PW);
    for (let i = 0; i < 5; i++) expect(await lock.verify(WRONG)).toBe('bad');
    expect(await lock.verify(PW)).toBe('wait');
    expect(await lock.verify(WRONG)).toBe('wait');
    c.advance(29_999);
    expect(await lock.verify(PW)).toBe('wait');
    c.advance(1);
    expect(await lock.verify(PW)).toBe('ok');
  });

  it('a correct password resets the wrong-try count', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    for (let i = 0; i < 4; i++) expect(await lock.verify(WRONG)).toBe('bad');
    expect(await lock.verify(PW)).toBe('ok');
    for (let i = 0; i < 4; i++) expect(await lock.verify(WRONG)).toBe('bad');
    expect(await lock.verify(PW)).toBe('ok');
  });

  it('set with a wrong current counts toward the same throttle and reports TOO_MANY_TRIES', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    for (let i = 0; i < 5; i++) await expect(lock.set(PW2, WRONG)).rejects.toBeInstanceOf(AppLockError);
    await expect(lock.set(PW2, PW)).rejects.toMatchObject({ code: 'TOO_MANY_TRIES' });
  });
});

describe('PIN format at every entry point', () => {
  // Not 6 ASCII digits: too short, too long, letters, spaces, a newline, full-width digits, a number, nothing.
  const BAD: unknown[] = ['12345', '1234567', '12345a', ' 123456', '123456\n', '１２３４５６', '', 123456, null, undefined];

  it('set (first PIN) refuses a malformed PIN with PIN_INVALID', async () => {
    const lock = makeLock(tmpDir());
    for (const b of BAD) await expect(lock.set(b as string)).rejects.toMatchObject({ code: 'PIN_INVALID' });
    expect(lock.configured()).toBe(false);
  });

  it('change refuses a malformed next or current with PIN_INVALID, and no try is counted', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    for (const b of BAD) await expect(lock.set(PW2, b as string)).rejects.toMatchObject({ code: 'PIN_INVALID' });
    await expect(lock.set(PW2)).rejects.toMatchObject({ code: 'PIN_INVALID' });
    for (let i = 0; i < 10; i++) await expect(lock.set('abc', PW)).rejects.toMatchObject({ code: 'PIN_INVALID' });
    // Still four tries left: four wrong PINs are plain 'bad', not 'wait'.
    for (let i = 0; i < 4; i++) expect(await lock.verify(WRONG)).toBe('bad');
    expect(await lock.verify(PW)).toBe('ok');
  });

  it('remove refuses a malformed current with PIN_INVALID and counts nothing', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    for (const b of BAD) await expect(lock.remove(b as string)).rejects.toMatchObject({ code: 'PIN_INVALID' });
    expect(lock.configured()).toBe(true);
    for (let i = 0; i < 4; i++) expect(await lock.verify(WRONG)).toBe('bad');
    expect(await lock.verify(PW)).toBe('ok');
  });

  it('verify throws PIN_INVALID before scrypt runs', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    const spy = vi.spyOn(crypto, 'scrypt');
    for (const b of BAD) await expect(lock.verify(b as string)).rejects.toMatchObject({ code: 'PIN_INVALID' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('escalating lockout (30 s, 2 min, 10 min, 30 min, then 30 min)', () => {
  /** Five wrong PINs in a row, each one expected to be a plain 'bad' (not locked yet). */
  async function wrongBlock(lock: AppLock, n = 5): Promise<void> {
    for (let i = 0; i < n; i++) expect(await lock.verify(WRONG)).toBe('bad');
  }

  it('each block of 5 wrong PINs locks for the next step, and the last step repeats', async () => {
    const c = clock();
    const lock = makeLock(tmpDir(), c);
    await lock.set(PW);
    for (const step of [30_000, 120_000, 600_000, 1_800_000, 1_800_000]) {
      await wrongBlock(lock);
      expect(lock.retryAfterMs()).toBe(step);
      expect(await lock.verify(PW)).toBe('wait');
      c.advance(step - 1);
      expect(await lock.verify(PW)).toBe('wait');
      expect(lock.retryAfterMs()).toBe(1);
      c.advance(1);
      expect(lock.retryAfterMs()).toBe(0);
    }
    expect(await lock.verify(PW)).toBe('ok');
  });

  it('during a wait verify answers wait without calling scrypt', async () => {
    const c = clock();
    const lock = makeLock(tmpDir(), c);
    await lock.set(PW);
    await wrongBlock(lock);
    const spy = vi.spyOn(crypto, 'scrypt');
    for (let i = 0; i < 20; i++) expect(await lock.verify(PW)).toBe('wait');
    c.advance(29_999);
    expect(await lock.verify(WRONG)).toBe('wait');
    expect(spy).not.toHaveBeenCalled();
    c.advance(1);
    expect(await lock.verify(PW)).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('parallel guesses: at most 5 are checked per block, the rest answer wait', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    const spy = vi.spyOn(crypto, 'scrypt');
    const results = await Promise.all(Array.from({ length: 8 }, () => lock.verify(WRONG)));
    expect(results.filter((r) => r === 'bad')).toHaveLength(5);
    expect(results.filter((r) => r === 'wait')).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(5);
    expect(lock.retryAfterMs()).toBe(30_000);
  });

  it('a correct PIN resets the tier: the next block is 30 s again', async () => {
    const c = clock();
    const lock = makeLock(tmpDir(), c);
    await lock.set(PW);
    await wrongBlock(lock);
    c.advance(30_000);
    await wrongBlock(lock);
    expect(lock.retryAfterMs()).toBe(120_000);
    c.advance(120_000);
    expect(await lock.verify(PW)).toBe('ok');
    await wrongBlock(lock);
    expect(lock.retryAfterMs()).toBe(30_000);
  });

  it('a verified set() counts as a correct PIN: tier and counters reset', async () => {
    const c = clock();
    const lock = makeLock(tmpDir(), c);
    await lock.set(PW);
    await wrongBlock(lock);
    c.advance(30_000);
    await wrongBlock(lock);
    c.advance(120_000);
    await lock.set(PW2, PW);
    await wrongBlock(lock);
    expect(lock.retryAfterMs()).toBe(30_000);
  });

  it('set() during a lockout refuses with TOO_MANY_TRIES and the remaining wait', async () => {
    const c = clock();
    const lock = makeLock(tmpDir(), c);
    await lock.set(PW);
    await wrongBlock(lock);
    c.advance(10_000);
    const err = await lock.set(PW2, PW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppLockError);
    expect(err).toMatchObject({ code: 'TOO_MANY_TRIES', retryAfterMs: 20_000 });
    expect(await lock.verify(PW)).toBe('wait');
  });

  it('retryAfterMs is 0 when not locked and counts down while locked', async () => {
    const c = clock();
    const lock = makeLock(tmpDir(), c);
    await lock.set(PW);
    expect(lock.retryAfterMs()).toBe(0);
    await wrongBlock(lock);
    expect(lock.retryAfterMs()).toBe(30_000);
    c.advance(10_000);
    expect(lock.retryAfterMs()).toBe(20_000);
    c.advance(20_000);
    expect(lock.retryAfterMs()).toBe(0);
  });

  it('a new instance (server restart) has no lockout and starts the tiers over', async () => {
    const dir = tmpDir();
    const c = clock();
    const a = makeLock(dir, c);
    await a.set(PW);
    await wrongBlock(a);
    c.advance(30_000);
    await wrongBlock(a); // a is now on the 2 min step
    expect(a.retryAfterMs()).toBe(120_000);

    const b = makeLock(dir, c);
    expect(b.retryAfterMs()).toBe(0);
    expect(await b.verify(PW)).toBe('ok');
    await wrongBlock(b);
    expect(b.retryAfterMs()).toBe(30_000);
  });
});

describe('sessions and cookie', () => {
  it('cookie is HttpOnly, SameSite=Strict, Path=/ and has no Max-Age or Expires', () => {
    const lock = makeLock(tmpDir());
    const sid = 'ab'.repeat(32);
    const c = lock.cookieHeader(sid);
    expect(c).toBe(`cr_session=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).not.toMatch(/Max-Age/i);
    expect(c).not.toMatch(/Expires/i);
  });

  it('createSession gives 64 hex chars from random bytes and hasSession finds it', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    const sid = lock.createSession();
    expect(sid).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.hasSession(lock.cookieHeader(sid))).toBe(true);
    expect(lock.hasSession(undefined)).toBe(false);
    expect(lock.hasSession('cr_session=nope')).toBe(false);
    lock.dropSession(lock.cookieHeader(sid));
    expect(lock.hasSession(lock.cookieHeader(sid))).toBe(false);
  });

  it('a session id from another AppLock instance is invalid', async () => {
    const dir = tmpDir();
    const a = makeLock(dir);
    await a.set(PW);
    const sid = a.createSession();
    const b = makeLock(dir);
    expect(await b.verify(PW)).toBe('ok');
    expect(b.hasSession(a.cookieHeader(sid))).toBe(false);
    expect(a.hasSession(a.cookieHeader(sid))).toBe(true);
  });

  it('sessions are capped: the oldest one goes after 100', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    const first = lock.createSession();
    for (let i = 0; i < 100; i++) lock.createSession();
    expect(lock.hasSession(lock.cookieHeader(first))).toBe(false);
  });

  it('a session is never valid while no password is configured', () => {
    const lock = makeLock(tmpDir());
    expect(lock.configured()).toBe(false);
    expect(lock.wsAllowed(fakeReq('GET', '/ws'))).toBe(true);
  });
});

describe('guard', () => {
  async function locked() {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    const sid = lock.createSession();
    return { lock, sid, cookie: lock.cookieHeader(sid) };
  }

  it('allows everything when no password is set', () => {
    const lock = makeLock(tmpDir());
    for (const [m, u] of [['GET', '/api/accounts'], ['POST', '/api/accounts'], ['GET', '/']]) {
      const { res, out } = fakeRes();
      expect(lock.guard(fakeReq(m, u), res)).toBe(false);
      expect(out.status).toBeUndefined();
    }
  });

  it('with a password set, /api/accounts is denied 401 LOCKED without a session', async () => {
    const { lock } = await locked();
    const { res, out } = fakeRes();
    expect(lock.guard(fakeReq('GET', '/api/accounts'), res)).toBe(true);
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body ?? '')).toEqual({ ok: false, error: 'LOCKED' });
  });

  it('allows the unlock-free endpoints and static/SPA GETs without a session', async () => {
    const { lock } = await locked();
    const allowed: [string, string][] = [
      ['GET', '/api/auth/state'],
      ['POST', '/api/auth/unlock'],
      ['GET', '/health'],
      ['GET', '/'],
      ['GET', '/assets/app.js'],
      ['GET', '/some/spa/route'],
      ['OPTIONS', '/api/auth/password'],
    ];
    for (const [m, u] of allowed) {
      const { res, out } = fakeRes();
      expect(lock.guard(fakeReq(m, u), res), `${m} ${u}`).toBe(false);
      expect(out.status).toBeUndefined();
    }
  });

  it('denies the rest of /api and /api/auth without a session', async () => {
    const { lock } = await locked();
    const denied: [string, string][] = [
      ['GET', '/api/accounts'],
      ['POST', '/api/accounts/work/unlock'],
      ['PUT', '/api/settings'],
      ['POST', '/api/auth/lock'],
      ['PUT', '/api/auth/password'],
      ['POST', '/api/state'],
      ['DELETE', '/health'],
      ['POST', '/'],
    ];
    for (const [m, u] of denied) {
      const { res, out } = fakeRes();
      expect(lock.guard(fakeReq(m, u), res), `${m} ${u}`).toBe(true);
      expect(out.status).toBe(401);
    }
  });

  it('a live session cookie passes every path', async () => {
    const { lock, cookie } = await locked();
    for (const u of ['/api/accounts', '/api/settings', '/']) {
      const { res, out } = fakeRes();
      expect(lock.guard(fakeReq('GET', u, cookie), res)).toBe(false);
      expect(out.status).toBeUndefined();
    }
  });

  it('a session cookie from another instance does not pass', async () => {
    const { cookie } = await locked();
    const other = makeLock(tmpDir());
    await other.set(PW);
    const { res, out } = fakeRes();
    expect(other.guard(fakeReq('GET', '/api/accounts', cookie), res)).toBe(true);
    expect(out.status).toBe(401);
  });

  it('wsAllowed needs a live session when a password is set', async () => {
    const { lock, cookie } = await locked();
    expect(lock.wsAllowed(fakeReq('GET', '/ws'))).toBe(false);
    expect(lock.wsAllowed(fakeReq('GET', '/ws', cookie))).toBe(true);
    lock.dropSession(cookie);
    expect(lock.wsAllowed(fakeReq('GET', '/ws', cookie))).toBe(false);
  });
});

describe('secrets stay out of the file and the logs', () => {
  it('config.json never contains the plaintext password (checked on the file bytes)', async () => {
    const dir = tmpDir();
    const lock = makeLock(dir);
    await lock.set(PW);
    await lock.set(PW2, PW);
    const bytes = fs.readFileSync(configFile(dir));
    expect(bytes.includes(Buffer.from(PW))).toBe(false);
    expect(bytes.includes(Buffer.from(PW2))).toBe(false);
    expect(bytes.toString('utf8')).toContain('"appLock"');
  });

  it('the stored record is scrypt with the expected sizes', async () => {
    const dir = tmpDir();
    await makeLock(dir).set(PW);
    const rec = loadAppLock(dir);
    expect(rec).not.toBeNull();
    expect(rec?.kdf).toBe('scrypt');
    expect(rec?.N).toBe(TEST_N);
    expect(Buffer.from(rec!.salt, 'base64').length).toBe(16);
    expect(Buffer.from(rec!.hash, 'base64').length).toBe(32);
  });

  it('a password never reaches the console', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((k) => vi.spyOn(console, k as 'log'));
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    await lock.verify(WRONG);
    await lock.verify(PW);
    await lock.set(PW2, PW);
    const printed = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' ')));
    for (const line of printed) {
      expect(line).not.toContain(PW);
      expect(line).not.toContain(PW2);
    }
  });

  it('uses crypto.timingSafeEqual for the hash compare', async () => {
    const lock = makeLock(tmpDir());
    await lock.set(PW);
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    await lock.verify(WRONG);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toHaveLength(32);
  });
});
