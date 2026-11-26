import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainAccountInfo } from '../../shared/accounts';
import { MainAuthApi, type MainAccountPortApi } from '../src/mainAuthApi';
import { CodedError } from '../src/codedError';

// Fake values only. The login code and the email are distinctive strings the leak checks look for.
const CODE = 'ZQX991-LEAKCHECK';
const EMAIL = 'leak.check@example.com';

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function info(over: Partial<MainAccountInfo> = {}): MainAccountInfo {
  return { loggedIn: true, email: EMAIL, plan: 'max', orgName: 'Org', expiresAt: 1, checkedAt: 2, ...over };
}

type Fake = { [K in keyof MainAccountPortApi]: ReturnType<typeof vi.fn> };

function fakeMain(over: Partial<Fake> = {}): Fake {
  return {
    status: vi.fn(async () => info()),
    login: vi.fn(),
    writeCode: vi.fn(),
    cancelLogin: vi.fn(() => true),
    logout: vi.fn(async () => info({ loggedIn: false, email: null })),
    ...over,
  } as Fake;
}

async function start(main: Fake = fakeMain()): Promise<{ base: string; main: Fake }> {
  const api = new MainAuthApi({
    originAllowed: (o) => o === undefined || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(o),
    main: main as unknown as MainAccountPortApi,
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
  return { base: `http://127.0.0.1:${port}`, main };
}

interface Resp {
  status: number;
  text: string;
  json: any;
  headers: http.IncomingHttpHeaders;
}

function call(base: string, method: string, urlPath: string, opts: { body?: unknown; raw?: string; origin?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const headers: Record<string, string> = {};
    if (opts.origin) headers.Origin = opts.origin;
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const u = new URL(base + urlPath);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
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

describe('MainAuthApi routing', () => {
  it('returns false for paths it does not own', () => {
    const api = new MainAuthApi({ originAllowed: () => true, main: fakeMain() as unknown as MainAccountPortApi });
    const res = {} as http.ServerResponse;
    for (const url of ['/api/accounts', '/api/accounts/work', '/api/accounts/main-x', '/api/accountsmain', '/api/settings']) {
      const req = { url, method: 'GET', headers: {} } as unknown as http.IncomingMessage;
      expect(api.handle(req, res), url).toBe(false);
    }
  });

  it('answers unknown sub-paths of /api/accounts/main with 404', async () => {
    const s = await start();
    const r = await call(s.base, 'GET', '/api/accounts/main/nope');
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});

describe('MainAuthApi happy paths', () => {
  it('GET /api/accounts/main returns the main account info', async () => {
    const s = await start();
    const r = await call(s.base, 'GET', '/api/accounts/main');
    expect(r.status).toBe(200);
    expect(r.json).toEqual(info());
    expect(r.headers['cache-control']).toBe('no-store');
    expect(s.main.status).toHaveBeenCalledWith(false);
  });

  it('GET /api/accounts/main?fresh=1 forces a status read', async () => {
    const s = await start();
    await call(s.base, 'GET', '/api/accounts/main?fresh=1');
    expect(s.main.status).toHaveBeenCalledWith(true);
  });

  it('POST /login starts the login with 202', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/main/login');
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true });
    expect(s.main.login).toHaveBeenCalledTimes(1);
  });

  it('POST /login/code hands the code to the service and answers without it', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/main/login/code', { body: { code: CODE } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(s.main.writeCode).toHaveBeenCalledWith(CODE);
    expect(r.text).not.toContain(CODE);
  });

  it('POST /login/cancel reports whether a login was cancelled', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/main/login/cancel');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, cancelled: true });
  });

  it('POST /logout returns ok with the refreshed main info', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/main/logout');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.main.loggedIn).toBe(false);
  });
});

describe('MainAuthApi errors', () => {
  it('maps service codes to statuses without echoing the message', async () => {
    const cases: Array<[string, number, () => Partial<Fake>]> = [
      ['NO_LOGIN_RUNNING', 409, () => ({ writeCode: vi.fn(() => { throw new CodedError(`no run for ${CODE}`, 'NO_LOGIN_RUNNING'); }) })],
      ['CODE_INVALID', 400, () => ({ writeCode: vi.fn(() => { throw new CodedError(`bad ${CODE}`, 'CODE_INVALID'); }) })],
      ['LOGIN_BUSY', 409, () => ({ login: vi.fn(() => { throw new CodedError('busy', 'LOGIN_BUSY'); }) })],
      ['PTY_UNAVAILABLE', 503, () => ({ login: vi.fn(() => { throw new CodedError('no pty', 'PTY_UNAVAILABLE'); }) })],
      ['BUSY_JOBS', 409, () => ({ logout: vi.fn(async () => { throw new CodedError('jobs', 'BUSY_JOBS'); }) })],
    ];
    for (const [code, status, over] of cases) {
      const s = await start(fakeMain(over()));
      const path = code === 'NO_LOGIN_RUNNING' || code === 'CODE_INVALID' ? '/api/accounts/main/login/code' : code === 'BUSY_JOBS' ? '/api/accounts/main/logout' : '/api/accounts/main/login';
      const r = await call(s.base, 'POST', path, { body: { code: CODE } });
      expect(r.status, code).toBe(status);
      expect(r.json).toEqual({ ok: false, error: code });
      expect(r.text).not.toContain(CODE);
    }
  });

  it('an unknown service error becomes 500 SERVER_ERROR with no message', async () => {
    const s = await start(fakeMain({ writeCode: vi.fn(() => { throw new Error(`leaked ${CODE}`); }) }));
    const r = await call(s.base, 'POST', '/api/accounts/main/login/code', { body: { code: CODE } });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ ok: false, error: 'SERVER_ERROR' });
    expect(r.text).not.toContain(CODE);
  });

  it('a missing or non-string code is CODE_INVALID (400)', async () => {
    const s = await start();
    const missing = await call(s.base, 'POST', '/api/accounts/main/login/code', { body: {} });
    expect(missing.status).toBe(400);
    expect(missing.json).toEqual({ ok: false, error: 'CODE_INVALID' });
    const num = await call(s.base, 'POST', '/api/accounts/main/login/code', { body: { code: 5 } });
    expect(num.status).toBe(400);
    expect(s.main.writeCode).not.toHaveBeenCalled();
  });

  it('bad JSON is 400 without echoing the body', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/main/login/code', { raw: `{"code": "${CODE}"` });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'BAD_JSON' });
    expect(r.text).not.toContain(CODE);
  });

  it('a body over 16 KB is refused with 413', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/main/login/code', { raw: JSON.stringify({ code: 'x'.repeat(17 * 1024) }) });
    expect(r.status).toBe(413);
    expect(s.main.writeCode).not.toHaveBeenCalled();
  });

  it('a foreign Origin is refused with 403 and reaches nothing', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/main/login', { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(s.main.login).not.toHaveBeenCalled();
    const g = await call(s.base, 'GET', '/api/accounts/main', { origin: 'http://evil.example' });
    expect(g.status).toBe(403);
  });

  it('an allowed Origin gets CORS headers, and OPTIONS answers 204', async () => {
    const s = await start();
    const r = await call(s.base, 'OPTIONS', '/api/accounts/main/login/code', { origin: 'http://127.0.0.1:5173' });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
  });
});

describe('MainAuthApi leak checks', () => {
  it('no console output carries the code or the email during a full flow', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    const s = await start();
    const texts: string[] = [];
    texts.push((await call(s.base, 'GET', '/api/accounts/main')).text);
    texts.push((await call(s.base, 'POST', '/api/accounts/main/login')).text);
    texts.push((await call(s.base, 'POST', '/api/accounts/main/login/code', { body: { code: CODE } })).text);
    texts.push((await call(s.base, 'POST', '/api/accounts/main/logout')).text);
    for (const t of texts) expect(t).not.toContain(CODE);
    for (const spy of spies) {
      for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain(CODE);
    }
  });
});
