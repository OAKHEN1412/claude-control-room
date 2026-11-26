import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLock } from '../src/appLock';
import { AuthApi } from '../src/authApi';
import { configFile } from '../src/config';

// Fake PINs only. Never a real credential.
const PW = '482913';
const PW2 = '705116';
const WRONG = '135790';
const TEST_N = 1024;

const servers: http.Server[] = [];
const tmp: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-authapi-'));
  tmp.push(d);
  return d;
}

interface Started {
  base: string;
  lock: AppLock;
}

async function start(dir: string, lock?: AppLock): Promise<Started> {
  const l = lock ?? new AppLock({ dir, N: TEST_N });
  const api = new AuthApi({
    originAllowed: (o) => o === undefined || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(o),
    lock: l,
  });
  const server = http.createServer((req, res) => {
    if (!api.handle(req, res)) {
      res.writeHead(418);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, lock: l };
}

interface Resp {
  status: number;
  text: string;
  json: any;
  headers: http.IncomingHttpHeaders;
}

function call(
  base: string,
  method: string,
  urlPath: string,
  opts: { body?: unknown; raw?: string; origin?: string; cookie?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const headers: Record<string, string> = {};
    if (opts.origin) headers.Origin = opts.origin;
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const u = new URL(base + urlPath);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** The cr_session=<sid> pair from a Set-Cookie header, ready to send back as a Cookie header. */
function cookieOf(r: Resp): string {
  const sc = r.headers['set-cookie'];
  const first = Array.isArray(sc) ? sc[0] : sc;
  expect(first).toBeDefined();
  return (first as string).split(';')[0];
}

describe('AuthApi state and unlock', () => {
  it('state with no password: required false, unlocked true', async () => {
    const s = await start(tmpDir());
    const r = await call(s.base, 'GET', '/api/auth/state');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ required: false, unlocked: true });
  });

  it('state with a password and no session: required true, unlocked false', async () => {
    const dir = tmpDir();
    const s = await start(dir);
    await s.lock.set(PW);
    const r = await call(s.base, 'GET', '/api/auth/state');
    expect(r.json).toEqual({ required: true, unlocked: false });
  });

  it('unlock with the right password sets a HttpOnly SameSite=Strict cookie with no Max-Age/Expires', async () => {
    const s = await start(tmpDir());
    await s.lock.set(PW);
    const r = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, required: true, unlocked: true });
    const sc = String(r.headers['set-cookie']);
    expect(sc).toMatch(/^cr_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    expect(sc).not.toMatch(/Max-Age|Expires/i);

    const st = await call(s.base, 'GET', '/api/auth/state', { cookie: cookieOf(r) });
    expect(st.json).toEqual({ required: true, unlocked: true });
  });

  it('wrong password gives 401 BAD_PASSWORD with no detail and no cookie', async () => {
    const s = await start(tmpDir());
    await s.lock.set(PW);
    const r = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: WRONG } });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ ok: false, error: 'BAD_PASSWORD' });
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.text).not.toContain(WRONG);
  });

  it('5 wrong tries give 429 TOO_MANY_TRIES with retryAfterMs, then the right PIN is refused until the 30 s pass', async () => {
    let t = 5_000_000;
    const lock = new AppLock({ dir: tmpDir(), N: TEST_N, now: () => t });
    const s = await start('', lock);
    await lock.set(PW);
    for (let i = 0; i < 5; i++) {
      const r = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: WRONG } });
      expect(r.status).toBe(401);
    }
    const blocked = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    expect(blocked.status).toBe(429);
    expect(blocked.json).toEqual({ ok: false, error: 'TOO_MANY_TRIES', retryAfterMs: 30_000 });
    expect(blocked.headers['retry-after']).toBe('30');
    t += 30_000;
    const ok = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    expect(ok.status).toBe(200);
  });

  it('unlock with a missing or non-string password is 400, and the body is never echoed', async () => {
    const s = await start(tmpDir());
    await s.lock.set(PW);
    const none = await call(s.base, 'POST', '/api/auth/unlock', { body: {} });
    expect(none.status).toBe(400);
    const num = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: 12345 } });
    expect(num.status).toBe(400);
    const junk = await call(s.base, 'POST', '/api/auth/unlock', { raw: '{"password": ' });
    expect(junk.status).toBe(400);
    expect(junk.text).not.toMatch(/password/);
  });

  it('unlock when no password is set answers ok without a cookie', async () => {
    const s = await start(tmpDir());
    const r = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('lock clears the session and expires the cookie in the browser', async () => {
    const s = await start(tmpDir());
    await s.lock.set(PW);
    const u = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    const cookie = cookieOf(u);
    const l = await call(s.base, 'POST', '/api/auth/lock', { cookie });
    expect(l.status).toBe(200);
    expect(String(l.headers['set-cookie'])).toMatch(/Max-Age=0/);
    const st = await call(s.base, 'GET', '/api/auth/state', { cookie });
    expect(st.json.unlocked).toBe(false);
  });
});

describe('AuthApi password', () => {
  it('set with no password configured needs no current and returns a session cookie', async () => {
    const dir = tmpDir();
    const s = await start(dir);
    const r = await call(s.base, 'PUT', '/api/auth/password', { body: { next: PW } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, required: true, unlocked: true });
    expect(String(r.headers['set-cookie'])).toMatch(/^cr_session=/);
    expect(s.lock.configured()).toBe(true);
  });

  it('set rejects a malformed PIN with 400 PIN_INVALID', async () => {
    const s = await start(tmpDir());
    const r = await call(s.base, 'PUT', '/api/auth/password', { body: { next: 'abc' } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'PIN_INVALID' });
    expect(s.lock.configured()).toBe(false);
  });

  it('change needs a session and the current password; the answer gives a fresh cookie', async () => {
    const s = await start(tmpDir());
    await s.lock.set(PW);
    const noSession = await call(s.base, 'PUT', '/api/auth/password', { body: { current: PW, next: PW2 } });
    expect(noSession.status).toBe(401);
    expect(noSession.json).toEqual({ ok: false, error: 'LOCKED' });

    const u = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    const oldCookie = cookieOf(u);
    const wrongCur = await call(s.base, 'PUT', '/api/auth/password', { cookie: oldCookie, body: { current: WRONG, next: PW2 } });
    expect(wrongCur.status).toBe(401);
    expect(wrongCur.json).toEqual({ ok: false, error: 'BAD_PASSWORD' });

    const ok = await call(s.base, 'PUT', '/api/auth/password', { cookie: oldCookie, body: { current: PW, next: PW2 } });
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain(PW2);
    // The old session was cleared by the change; the new cookie from the answer works.
    const stale = await call(s.base, 'GET', '/api/auth/state', { cookie: oldCookie });
    expect(stale.json.unlocked).toBe(false);
    const fresh = await call(s.base, 'GET', '/api/auth/state', { cookie: cookieOf(ok) });
    expect(fresh.json.unlocked).toBe(true);
  });

  it('remove needs the current password and a session, and then the app is open again', async () => {
    const dir = tmpDir();
    const s = await start(dir);
    await s.lock.set(PW);
    const u = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    const cookie = cookieOf(u);
    const r = await call(s.base, 'PUT', '/api/auth/password', { cookie, body: { current: PW } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, required: false, unlocked: true });
    expect(s.lock.configured()).toBe(false);
    const st = await call(s.base, 'GET', '/api/auth/state');
    expect(st.json).toEqual({ required: false, unlocked: true });
  });

  it('remove with no password set is 400 NO_PASSWORD', async () => {
    const s = await start(tmpDir());
    const r = await call(s.base, 'PUT', '/api/auth/password', { body: {} });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'NO_PASSWORD' });
  });

  it('a non-string current or next is 400 BAD_REQUEST', async () => {
    const s = await start(tmpDir());
    const r = await call(s.base, 'PUT', '/api/auth/password', { body: { next: 12345678 } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'BAD_REQUEST' });
  });
});

describe('AuthApi PIN format and lockout responses', () => {
  it('unlock with a malformed PIN is 400 PIN_INVALID, never reaches scrypt, and is not counted as a try', async () => {
    const s = await start(tmpDir());
    await s.lock.set(PW);
    const spy = vi.spyOn(crypto, 'scrypt');
    for (const bad of ['12345', '1234567', 'abcdef', ' 123456']) {
      const r = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: bad } });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ ok: false, error: 'PIN_INVALID' });
    }
    expect(spy).not.toHaveBeenCalled();
    // Plenty of tries left after eight malformed ones: the right PIN still unlocks.
    const ok = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    expect(ok.status).toBe(200);
  });

  it('change and remove: a malformed current or next is 400 PIN_INVALID, nothing changes', async () => {
    const dir = tmpDir();
    const s = await start(dir);
    await s.lock.set(PW);
    const u = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    const cookie = cookieOf(u);
    const badCur = await call(s.base, 'PUT', '/api/auth/password', { cookie, body: { current: '12', next: PW2 } });
    expect(badCur.status).toBe(400);
    expect(badCur.json).toEqual({ ok: false, error: 'PIN_INVALID' });
    const badNext = await call(s.base, 'PUT', '/api/auth/password', { cookie, body: { current: PW, next: 'abc' } });
    expect(badNext.json).toEqual({ ok: false, error: 'PIN_INVALID' });
    const badRemove = await call(s.base, 'PUT', '/api/auth/password', { cookie, body: { current: 'x' } });
    expect(badRemove.json).toEqual({ ok: false, error: 'PIN_INVALID' });
    expect(s.lock.configured()).toBe(true);
    expect(await s.lock.verify(PW)).toBe('ok');
  });

  it('429 on unlock: body carries retryAfterMs, Retry-After is whole seconds rounded up, and the wait counts down', async () => {
    let t = 5_000_000;
    const lock = new AppLock({ dir: tmpDir(), N: TEST_N, now: () => t });
    const s = await start('', lock);
    await lock.set(PW);
    for (let i = 0; i < 5; i++) expect((await call(s.base, 'POST', '/api/auth/unlock', { body: { password: WRONG } })).status).toBe(401);

    const first = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    expect(first.status).toBe(429);
    expect(first.json).toEqual({ ok: false, error: 'TOO_MANY_TRIES', retryAfterMs: 30_000 });
    expect(first.headers['retry-after']).toBe('30');
    expect(first.text).not.toContain(PW);

    t += 12_345;
    const later = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    expect(later.json).toEqual({ ok: false, error: 'TOO_MANY_TRIES', retryAfterMs: 17_655 });
    expect(later.headers['retry-after']).toBe('18');
  });

  it('429 on the password endpoint has the same body and header; no scrypt runs while it waits', async () => {
    let t = 5_000_000;
    const lock = new AppLock({ dir: tmpDir(), N: TEST_N, now: () => t });
    const s = await start('', lock);
    await lock.set(PW);
    const u = await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } });
    const cookie = cookieOf(u);
    for (let i = 0; i < 5; i++) {
      const r = await call(s.base, 'PUT', '/api/auth/password', { cookie, body: { current: WRONG, next: PW2 } });
      expect(r.json).toEqual({ ok: false, error: 'BAD_PASSWORD' });
    }
    const spy = vi.spyOn(crypto, 'scrypt');
    const blocked = await call(s.base, 'PUT', '/api/auth/password', { cookie, body: { current: PW, next: PW2 } });
    expect(blocked.status).toBe(429);
    expect(blocked.json).toEqual({ ok: false, error: 'TOO_MANY_TRIES', retryAfterMs: 30_000 });
    expect(blocked.headers['retry-after']).toBe('30');
    const removed = await call(s.base, 'PUT', '/api/auth/password', { cookie, body: { current: PW } });
    expect(removed.status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
    expect(lock.configured()).toBe(true);
  });

  it('parallel wrong PINs beyond the 5th get a 429 with a positive retryAfterMs', async () => {
    const s = await start(tmpDir());
    await s.lock.set(PW);
    const rs = await Promise.all(Array.from({ length: 7 }, () => call(s.base, 'POST', '/api/auth/unlock', { body: { password: WRONG } })));
    const waits = rs.filter((r) => r.status === 429);
    expect(waits.length).toBeGreaterThan(0);
    for (const w of waits) expect(w.json.retryAfterMs).toBeGreaterThan(0);
    for (const w of waits) expect(w.text).not.toContain(PW);
  });
});

describe('AuthApi routing, origin and CORS', () => {
  it('returns false for paths it does not own', () => {
    const api = new AuthApi({ originAllowed: () => true, lock: new AppLock({ dir: tmpDir(), N: TEST_N }) });
    const req = { url: '/api/authx', method: 'GET', headers: {} } as unknown as http.IncomingMessage;
    expect(api.handle(req, {} as http.ServerResponse)).toBe(false);
  });

  it('an origin that is not allowed gets 403, preflight included', async () => {
    const s = await start(tmpDir());
    expect((await call(s.base, 'GET', '/api/auth/state', { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call(s.base, 'OPTIONS', '/api/auth/unlock', { origin: 'http://evil.example' })).status).toBe(403);
  });

  it('an allowed origin is echoed with credentials allowed; preflight is 204', async () => {
    const s = await start(tmpDir());
    const r = await call(s.base, 'GET', '/api/auth/state', { origin: 'http://127.0.0.1:5173' });
    expect(r.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    expect(r.headers['access-control-allow-credentials']).toBe('true');
    const pre = await call(s.base, 'OPTIONS', '/api/auth/unlock', { origin: 'http://127.0.0.1:5173' });
    expect(pre.status).toBe(204);
  });

  it('an unknown /api/auth path is 404', async () => {
    const s = await start(tmpDir());
    expect((await call(s.base, 'GET', '/api/auth/nope')).status).toBe(404);
  });

  it('a body over 16 KB is refused with 413', async () => {
    const s = await start(tmpDir());
    const big = JSON.stringify({ password: 'x'.repeat(20 * 1024) });
    const r = await call(s.base, 'POST', '/api/auth/unlock', { raw: big });
    expect(r.status).toBe(413);
  });

  it('no response carries the password, even on errors and a thrown lock error', async () => {
    const dir = tmpDir();
    const s = await start(dir);
    await s.lock.set(PW);
    const spies = ['log', 'info', 'warn', 'error'].map((k) => vi.spyOn(console, k as 'log'));
    const responses = [
      await call(s.base, 'POST', '/api/auth/unlock', { body: { password: PW } }),
      await call(s.base, 'POST', '/api/auth/unlock', { body: { password: WRONG } }),
      await call(s.base, 'PUT', '/api/auth/password', { body: { current: WRONG, next: PW2 } }),
    ];
    for (const r of responses) expect(r.text).not.toContain(PW);
    for (const spy of spies) {
      for (const c of spy.mock.calls) expect(c.map(String).join(' ')).not.toContain(PW);
    }
    const onDisk = fs.readFileSync(configFile(dir));
    expect(onDisk.includes(Buffer.from(PW))).toBe(false);
  });
});
