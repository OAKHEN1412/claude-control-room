import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelMainLogin,
  getMainAccount,
  listAccounts,
  mainLogout,
  sendMainLoginCode,
  setAccountPassword,
  startMainLogin,
  unlockAccount,
} from './accountsClient';

const BASE = 'http://127.0.0.1:8790';

interface Call { url: string; init: RequestInit }

/** Fake fetch: records every call and answers with the given status and JSON body. */
function fake(status: number, body: unknown | string) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status });
  };
  return { f, calls };
}

function failing() {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    throw new TypeError('fetch failed');
  };
  return { f, calls };
}

beforeEach(() => {
  // apiBase() reads window.location; the node test env has no window.
  vi.stubGlobal('window', { location: { hostname: '127.0.0.1', port: '' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('main account calls', () => {
  it('getMainAccount sends a bare GET and passes the fresh flag as a query', async () => {
    const info = { loggedIn: true, email: 'a@b.c', plan: 'pro', orgName: null, expiresAt: null, checkedAt: 1 };
    const a = fake(200, info);
    const r = await getMainAccount(false, a.f);
    expect(r).toEqual({ ok: true, ...info });
    expect(a.calls[0].url).toBe(`${BASE}/api/accounts/main`);
    expect(a.calls[0].init.method).toBe('GET');

    const b = fake(200, info);
    await getMainAccount(true, b.f);
    expect(b.calls[0].url).toBe(`${BASE}/api/accounts/main?fresh=1`);
  });

  it('every call sends credentials include', async () => {
    const a = fake(200, { ok: true });
    await startMainLogin(a.f);
    await mainLogout(a.f);
    expect(a.calls.every((c) => c.init.credentials === 'include')).toBe(true);
  });

  it('startMainLogin posts to the login route with no body', async () => {
    const a = fake(202, { ok: true });
    expect(await startMainLogin(a.f)).toEqual({ ok: true });
    expect(a.calls[0].url).toBe(`${BASE}/api/accounts/main/login`);
    expect(a.calls[0].init.method).toBe('POST');
    expect(a.calls[0].init.body).toBeUndefined();
  });

  it('sendMainLoginCode puts the code in the body, never in the URL', async () => {
    const a = fake(200, { ok: true });
    await sendMainLoginCode('SECRET-CODE-123', a.f);
    expect(a.calls[0].url).toBe(`${BASE}/api/accounts/main/login/code`);
    expect(a.calls[0].url).not.toContain('SECRET');
    expect(JSON.parse(String(a.calls[0].init.body))).toEqual({ code: 'SECRET-CODE-123' });
  });

  it('cancelMainLogin and mainLogout hit their routes', async () => {
    const a = fake(200, { ok: true, cancelled: true });
    expect(await cancelMainLogin(a.f)).toEqual({ ok: true, cancelled: true });
    expect(a.calls[0].url).toBe(`${BASE}/api/accounts/main/login/cancel`);
    const b = fake(200, { ok: true, main: { loggedIn: false } });
    expect(await mainLogout(b.f)).toEqual({ ok: true, main: { loggedIn: false } });
    expect(b.calls[0].url).toBe(`${BASE}/api/accounts/main/logout`);
    expect(b.calls[0].init.method).toBe('POST');
  });

  it('maps a server error code and never throws on a network failure', async () => {
    const a = fake(409, { ok: false, error: 'LOGIN_BUSY' });
    expect(await startMainLogin(a.f)).toEqual({ ok: false, error: 'LOGIN_BUSY' });
    const n = failing();
    expect(await startMainLogin(n.f)).toEqual({ ok: false, error: 'NETWORK' });
  });

  it('reports SERVER_ERROR when the body is not JSON', async () => {
    const a = fake(500, 'oops not json');
    expect(await getMainAccount(false, a.f)).toEqual({ ok: false, error: 'SERVER_ERROR' });
  });
});

describe('profile password calls', () => {
  it('unlockAccount posts the password in the body and encodes the id', async () => {
    const a = fake(200, { ok: true, account: { id: 'work' } });
    const r = await unlockAccount('work id', 'hunter22', a.f);
    expect(r).toEqual({ ok: true, account: { id: 'work' } });
    expect(a.calls[0].url).toBe(`${BASE}/api/accounts/work%20id/unlock`);
    expect(a.calls[0].url).not.toContain('hunter22');
    expect(JSON.parse(String(a.calls[0].init.body))).toEqual({ password: 'hunter22' });
  });

  it('unlockAccount maps BAD_PASSWORD and TOO_MANY_TRIES without detail', async () => {
    expect(await unlockAccount('w', 'x', fake(401, { ok: false, error: 'BAD_PASSWORD' }).f)).toEqual({ ok: false, error: 'BAD_PASSWORD' });
    expect(await unlockAccount('w', 'x', fake(429, { ok: false, error: 'TOO_MANY_TRIES' }).f)).toEqual({ ok: false, error: 'TOO_MANY_TRIES' });
  });

  it('setAccountPassword sends current and next only in the body', async () => {
    const a = fake(200, { ok: true, account: { id: 'w' } });
    await setAccountPassword('w', { current: 'old-pass', next: 'new-pass' }, a.f);
    expect(a.calls[0].init.method).toBe('PUT');
    expect(a.calls[0].url).toBe(`${BASE}/api/accounts/w/password`);
    expect(a.calls[0].url).not.toMatch(/old-pass|new-pass/);
    expect(JSON.parse(String(a.calls[0].init.body))).toEqual({ current: 'old-pass', next: 'new-pass' });
  });
});

describe('listAccounts (existing call) still sends credentials', () => {
  it('uses the bare GET and includes the cookie', async () => {
    const a = fake(200, { accounts: [], defaultId: 'terminal', ptyAvailable: false });
    const r = await listAccounts(a.f);
    expect(r.ok).toBe(true);
    expect(a.calls[0].init.credentials).toBe('include');
  });
});
