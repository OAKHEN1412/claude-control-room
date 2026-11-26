import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthState, lockApp, setAppPassword, unlockApp } from './authClient';

const BASE = 'http://127.0.0.1:8790';

interface Call { url: string; init: RequestInit }

function fake(status: number, body: unknown) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  };
  return { f, calls };
}

beforeEach(() => {
  vi.stubGlobal('window', { location: { hostname: '127.0.0.1', port: '' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authClient', () => {
  it('getAuthState reads the bare state with the cookie', async () => {
    const a = fake(200, { required: true, unlocked: false });
    expect(await getAuthState(a.f)).toEqual({ ok: true, required: true, unlocked: false });
    expect(a.calls[0].url).toBe(`${BASE}/api/auth/state`);
    expect(a.calls[0].init.method).toBe('GET');
    expect(a.calls[0].init.credentials).toBe('include');
  });

  it('unlockApp posts the password in the body only', async () => {
    const a = fake(200, { ok: true });
    expect(await unlockApp('app-pass', a.f)).toEqual({ ok: true });
    expect(a.calls[0].url).toBe(`${BASE}/api/auth/unlock`);
    expect(a.calls[0].url).not.toContain('app-pass');
    expect(JSON.parse(String(a.calls[0].init.body))).toEqual({ password: 'app-pass' });
    expect(a.calls[0].init.credentials).toBe('include');
  });

  it('unlockApp returns the server error code unchanged', async () => {
    expect(await unlockApp('x', fake(401, { ok: false, error: 'BAD_PASSWORD' }).f)).toEqual({ ok: false, error: 'BAD_PASSWORD' });
    expect(await unlockApp('x', fake(429, { ok: false, error: 'TOO_MANY_TRIES' }).f)).toEqual({ ok: false, error: 'TOO_MANY_TRIES' });
  });

  it('lockApp posts to the lock route', async () => {
    const a = fake(200, { ok: true });
    expect(await lockApp(a.f)).toEqual({ ok: true });
    expect(a.calls[0].url).toBe(`${BASE}/api/auth/lock`);
    expect(a.calls[0].init.method).toBe('POST');
    expect(a.calls[0].init.credentials).toBe('include');
  });

  it('setAppPassword sends set, change and remove shapes in the body', async () => {
    const a = fake(200, { ok: true });
    await setAppPassword({ next: 'first-pass' }, a.f);
    await setAppPassword({ current: 'first-pass', next: 'second-pass' }, a.f);
    await setAppPassword({ current: 'second-pass' }, a.f);
    expect(a.calls.every((c) => c.init.method === 'PUT' && c.url === `${BASE}/api/auth/password`)).toBe(true);
    expect(JSON.parse(String(a.calls[0].init.body))).toEqual({ next: 'first-pass' });
    expect(JSON.parse(String(a.calls[1].init.body))).toEqual({ current: 'first-pass', next: 'second-pass' });
    expect(JSON.parse(String(a.calls[2].init.body))).toEqual({ current: 'second-pass' });
    expect(a.calls.some((c) => c.url.includes('first-pass') || c.url.includes('second-pass'))).toBe(false);
  });

  it('keeps retryAfterMs from a TOO_MANY_TRIES body on unlock, set and change', async () => {
    const lock = { ok: false, error: 'TOO_MANY_TRIES', retryAfterMs: 120000 };
    expect(await unlockApp('123456', fake(429, lock).f)).toEqual(lock);
    expect(await setAppPassword({ next: '123456' }, fake(429, lock).f)).toEqual(lock);
    expect(await setAppPassword({ current: '111111', next: '222222' }, fake(429, lock).f)).toEqual(lock);
  });

  it('does not add retryAfterMs to other errors', async () => {
    expect(await unlockApp('000000', fake(401, { ok: false, error: 'BAD_PASSWORD' }).f)).toEqual({ ok: false, error: 'BAD_PASSWORD' });
    expect(await setAppPassword({ next: '12' }, fake(400, { ok: false, error: 'PIN_INVALID' }).f)).toEqual({ ok: false, error: 'PIN_INVALID' });
  });

  it('maps PIN_INVALID (wrong format, HTTP 400) and passes the code on', async () => {
    const r = await unlockApp('12a', fake(400, { ok: false, error: 'PIN_INVALID' }).f);
    expect(r).toEqual({ ok: false, error: 'PIN_INVALID' });
    expect(r).not.toHaveProperty('retryAfterMs');
  });

  it('never throws on a network failure', async () => {
    const f = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    expect(await getAuthState(f)).toEqual({ ok: false, error: 'NETWORK' });
    expect(await lockApp(f)).toEqual({ ok: false, error: 'NETWORK' });
  });
});
