import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo, AccountsView } from '../../shared/accounts';
import { AccountsApi, type AccountsPortApi } from '../src/accountsApi';
import { CodedError } from '../src/codedError';

// Fake token only, shaped like a real one so the redaction checks mean something. Never a real credential.
const TOKEN = 'sk-ant-oat01-' + 'B'.repeat(80);

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function account(over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: 'work', name: 'Work', color: '#ef4444', letter: 'W', note: '', builtin: false,
    tokenState: 'set', fingerprint: 'abcd1234', createdAt: 1, tokenAt: 2, expiresAt: 3,
    lastCheckAt: null, lastCheckOk: null, usage: null, hidden: false, locked: false, hasPassword: false, ...over,
  };
}

function view(): AccountsView {
  return { accounts: [account({ id: 'terminal', name: 'Main account', builtin: true, tokenState: 'unset', fingerprint: null }), account()], defaultId: 'terminal', ptyAvailable: true };
}

type Fake = { [K in keyof AccountsPortApi]: ReturnType<typeof vi.fn> };

/** A service double where every method succeeds unless a test overrides it. */
function fakeService(over: Partial<Fake> = {}): Fake {
  return {
    view: vi.fn(() => view()),
    create: vi.fn(() => account({ id: 'new-one', name: 'New' })),
    patch: vi.fn((id: string) => account({ id })),
    remove: vi.fn(async () => undefined),
    setDefault: vi.fn(),
    putToken: vi.fn(async () => account()),
    check: vi.fn(async () => account({ lastCheckOk: true })),
    refreshUsage: vi.fn(async () => account({ lastCheckOk: true })),
    connect: vi.fn(),
    cancelConnect: vi.fn(() => true),
    unlock: vi.fn(async (id: string) => account({ id, locked: false, hasPassword: true })),
    setPassword: vi.fn(async (id: string) => account({ id, hasPassword: true })),
    ...over,
  } as Fake;
}

interface Started {
  base: string;
  svc: Fake;
}

async function start(svc: Fake = fakeService()): Promise<Started> {
  const api = new AccountsApi({
    originAllowed: (o) => o === undefined || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(o),
    accounts: svc as unknown as AccountsPortApi,
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
  return { base: `http://127.0.0.1:${port}`, svc };
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

describe('AccountsApi routing', () => {
  it('returns false for paths it does not own', () => {
    const api = new AccountsApi({ originAllowed: () => true, accounts: fakeService() as unknown as AccountsPortApi });
    const res = {} as http.ServerResponse;
    for (const url of ['/api/settings', '/api/accountsX', '/api/account']) {
      const req = { url, method: 'GET', headers: {} } as unknown as http.IncomingMessage;
      expect(api.handle(req, res), url).toBe(false);
    }
  });
});

describe('AccountsApi happy paths', () => {
  it('GET /api/accounts returns the view with 200', async () => {
    const s = await start();
    const r = await call(s.base, 'GET', '/api/accounts');
    expect(r.status).toBe(200);
    expect(r.json).toEqual(view());
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('POST /api/accounts creates with 201 and passes the validated, trimmed input', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts', { body: { name: '  Team   A ', color: '#22c55e', letter: 'ta', note: ' n ', extra: 1 } });
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
    expect(r.json.account.id).toBe('new-one');
    expect(s.svc.create).toHaveBeenCalledWith({ name: 'Team A', color: '#22c55e', letter: 'TA', note: 'n' });
  });

  it('POST /api/accounts without a name is 400 NAME_INVALID and the service is not called', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts', { body: { color: '#22c55e' } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'NAME_INVALID' });
    expect(s.svc.create).not.toHaveBeenCalled();
  });

  it('PATCH /api/accounts/:id passes only the given fields, including hidden', async () => {
    const s = await start();
    const r = await call(s.base, 'PATCH', '/api/accounts/work', { body: { note: 'x', hidden: true } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(s.svc.patch).toHaveBeenCalledWith('work', { note: 'x', hidden: true });
  });

  it('PATCH with a non-boolean hidden is 400 BAD_REQUEST', async () => {
    const s = await start();
    const r = await call(s.base, 'PATCH', '/api/accounts/work', { body: { hidden: 'yes' } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(s.svc.patch).not.toHaveBeenCalled();
  });

  it('PATCH with an invalid field is 400 from validateProfileInput', async () => {
    const s = await start();
    const r = await call(s.base, 'PATCH', '/api/accounts/work', { body: { color: '#000000' } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'COLOR_INVALID' });
    expect(s.svc.patch).not.toHaveBeenCalled();
  });

  it('PATCH on the builtin account lets the service decide: hidden goes through, other fields map BUILTIN to 400', async () => {
    const svc = fakeService({
      patch: vi.fn((id: string, p: { name?: string }) => {
        if (p.name !== undefined) throw Object.assign(new Error('builtin'), { code: 'BUILTIN' });
        return account({ id, builtin: true });
      }),
    });
    const s = await start(svc);
    const ok = await call(s.base, 'PATCH', '/api/accounts/terminal', { body: { hidden: true } });
    expect(ok.status).toBe(200);
    expect(svc.patch).toHaveBeenCalledWith('terminal', { hidden: true });
    const no = await call(s.base, 'PATCH', '/api/accounts/terminal', { body: { name: 'Other' } });
    expect(no.status).toBe(400);
    expect(no.json).toEqual({ ok: false, error: 'BUILTIN' });
  });

  it('DELETE /api/accounts/:id removes with 200', async () => {
    const s = await start();
    const r = await call(s.base, 'DELETE', '/api/accounts/work');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(s.svc.remove).toHaveBeenCalledWith('work');
  });

  it('PUT /api/accounts/default sets the default and answers with defaultId', async () => {
    const s = await start();
    const r = await call(s.base, 'PUT', '/api/accounts/default', { body: { accountId: 'work' } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, defaultId: 'terminal' });
    expect(s.svc.setDefault).toHaveBeenCalledWith('work');
  });

  it('POST /api/accounts/:id/connect answers 202 and starts the flow', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/work/connect');
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true });
    expect(s.svc.connect).toHaveBeenCalledWith('work');
  });

  it('POST /api/accounts/:id/connect/cancel answers 200 with cancelled', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/work/connect/cancel');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, cancelled: true });
    expect(s.svc.cancelConnect).toHaveBeenCalledTimes(1);
  });

  it('PUT /api/accounts/:id/token passes the token to the service and answers with metadata', async () => {
    const s = await start();
    const r = await call(s.base, 'PUT', '/api/accounts/work/token', { body: { token: TOKEN } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, account: account() });
    expect(s.svc.putToken).toHaveBeenCalledWith('work', TOKEN);
  });

  it('PUT /api/accounts/:id/token with a non-string token is 400 TOKEN_INVALID and the service is not called', async () => {
    const s = await start();
    for (const body of [{ token: 12345 }, { token: null }, {}, [TOKEN], null]) {
      const r = await call(s.base, 'PUT', '/api/accounts/work/token', { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json).toEqual({ ok: false, error: 'TOKEN_INVALID' });
    }
    expect(s.svc.putToken).not.toHaveBeenCalled();
  });

  it('POST /api/accounts/:id/check answers 200 with the account', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/work/check');
    expect(r.status).toBe(200);
    expect(r.json.account.lastCheckOk).toBe(true);
    expect(s.svc.check).toHaveBeenCalledWith('work');
  });

  it('POST /api/accounts/:id/refresh-usage answers 200 with the account from refreshUsage, not check', async () => {
    const s = await start();
    const r = await call(s.base, 'POST', '/api/accounts/work/refresh-usage');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.account.id).toBe('work');
    expect(s.svc.refreshUsage).toHaveBeenCalledWith('work');
    expect(s.svc.check).not.toHaveBeenCalled();
  });

  it('refresh-usage maps BUILTIN to 400, NOT_FOUND to 404 and ACCOUNT_NO_TOKEN to 400, with no message', async () => {
    const cases: [string, number][] = [['BUILTIN', 400], ['NOT_FOUND', 404], ['ACCOUNT_NO_TOKEN', 400]];
    for (const [code, status] of cases) {
      const svc = fakeService({
        refreshUsage: vi.fn(async () => {
          throw Object.assign(new Error('detail that must not leak'), { srvCode: code });
        }),
      });
      const s = await start(svc);
      const r = await call(s.base, 'POST', '/api/accounts/terminal/refresh-usage');
      expect(r.status, code).toBe(status);
      expect(r.json).toEqual({ ok: false, error: code });
      expect(r.text).not.toContain('must not leak');
    }
  });

  it('an id that fails ACCOUNT_ID_RE on refresh-usage is 404 and never reaches the service', async () => {
    const s = await start();
    expect((await call(s.base, 'POST', '/api/accounts/Work%20A/refresh-usage')).status).toBe(404);
    expect(s.svc.refreshUsage).not.toHaveBeenCalled();
  });
});

describe('AccountsApi route order and ids', () => {
  it('PUT /api/accounts/default hits setDefault, never the :id routes', async () => {
    const s = await start();
    await call(s.base, 'PUT', '/api/accounts/default', { body: { accountId: 'terminal' } });
    expect(s.svc.setDefault).toHaveBeenCalledWith('terminal');
    expect(s.svc.putToken).not.toHaveBeenCalled();
    expect(s.svc.patch).not.toHaveBeenCalled();
  });

  it('PATCH or DELETE on /api/accounts/default is 404 (default is not an account id)', async () => {
    const s = await start();
    expect((await call(s.base, 'PATCH', '/api/accounts/default', { body: { hidden: true } })).status).toBe(404);
    expect((await call(s.base, 'DELETE', '/api/accounts/default')).status).toBe(404);
    expect(s.svc.patch).not.toHaveBeenCalled();
    expect(s.svc.remove).not.toHaveBeenCalled();
  });

  it('an id that does not match ACCOUNT_ID_RE is 404 and never reaches the service', async () => {
    const s = await start();
    expect((await call(s.base, 'PATCH', '/api/accounts/Bad_Id', { body: { note: 'x' } })).status).toBe(404);
    expect((await call(s.base, 'DELETE', '/api/accounts/' + 'a'.repeat(65))).status).toBe(404);
    expect((await call(s.base, 'POST', '/api/accounts/Work%20A/check')).status).toBe(404);
    expect(s.svc.patch).not.toHaveBeenCalled();
    expect(s.svc.remove).not.toHaveBeenCalled();
    expect(s.svc.check).not.toHaveBeenCalled();
  });

  it('unknown paths and wrong methods under /api/accounts are 404 NOT_FOUND', async () => {
    const s = await start();
    const cases: Array<[string, string]> = [
      ['GET', '/api/accounts/work/nope'],
      ['GET', '/api/accounts/work/connect'],
      ['POST', '/api/accounts/work/a/b/c'],
      ['DELETE', '/api/accounts'],
      ['PUT', '/api/accounts/work'],
      ['GET', '/api/accounts/'],
    ];
    for (const [method, path] of cases) {
      const r = await call(s.base, method, path);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json).toEqual({ ok: false, error: 'NOT_FOUND' });
    }
  });
});

describe('AccountsApi origin, CORS and body rules', () => {
  it('an evil Origin gets 403 on every method, OPTIONS included', async () => {
    const s = await start();
    const methods: Array<[string, string]> = [
      ['GET', '/api/accounts'], ['POST', '/api/accounts'], ['PATCH', '/api/accounts/work'],
      ['DELETE', '/api/accounts/work'], ['PUT', '/api/accounts/default'], ['POST', '/api/accounts/work/connect'],
      ['POST', '/api/accounts/work/connect/cancel'], ['PUT', '/api/accounts/work/token'],
      ['POST', '/api/accounts/work/check'], ['OPTIONS', '/api/accounts'],
    ];
    for (const [method, path] of methods) {
      const r = await call(s.base, method, path, { origin: 'https://evil.example' });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect(s.svc.view).not.toHaveBeenCalled();
    expect(s.svc.putToken).not.toHaveBeenCalled();
  });

  it('an allowed Origin is echoed and OPTIONS answers 204 with the methods', async () => {
    const s = await start();
    const r = await call(s.base, 'GET', '/api/accounts', { origin: 'http://127.0.0.1:5173' });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    const pre = await call(s.base, 'OPTIONS', '/api/accounts/work', { origin: 'http://127.0.0.1:5173' });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toBe('GET, POST, PUT, PATCH, DELETE');
  });

  it('malformed JSON gives 400 BAD_JSON without echoing the body', async () => {
    const s = await start();
    const r = await call(s.base, 'PUT', '/api/accounts/work/token', { raw: '{"token": "' + TOKEN + '"' });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'BAD_JSON' });
    expect(r.text).not.toContain(TOKEN);
    expect(s.svc.putToken).not.toHaveBeenCalled();
    const r2 = await call(s.base, 'POST', '/api/accounts', { raw: '{"name": nope' });
    expect(r2.status).toBe(400);
    expect(r2.json).toEqual({ ok: false, error: 'BAD_JSON' });
  });

  it('a body over 16 KB gives 413 BODY_TOO_LARGE', async () => {
    const s = await start();
    const big = JSON.stringify({ name: 'x'.repeat(17 * 1024) });
    const r = await call(s.base, 'POST', '/api/accounts', { raw: big });
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ ok: false, error: 'BODY_TOO_LARGE' });
    expect(s.svc.create).not.toHaveBeenCalled();
  });
});

describe('AccountsApi maps srvCode errors (CodedError)', () => {
  const srvCases: Array<[string, number, string]> = [
    ['NAME_INVALID', 400, 'NAME_INVALID'],
    ['CONNECT_BUSY', 409, 'CONNECT_BUSY'],
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['srv.account.noToken', 400, 'ACCOUNT_NO_TOKEN'],
  ];
  it.each(srvCases)('srvCode %s -> %i with error %s', async (srvCode, status, error) => {
    const boom = () => {
      throw Object.assign(new Error('internal detail'), { srvCode });
    };
    const svc = fakeService({ view: vi.fn(boom) });
    const s = await start(svc);
    const r = await call(s.base, 'GET', '/api/accounts');
    expect(r.status).toBe(status);
    expect(r.json).toEqual({ ok: false, error });
    expect(r.text).not.toContain('internal detail');
  });

  it('an unknown srvCode -> 500 SERVER_ERROR with no message', async () => {
    const svc = fakeService({
      view: vi.fn(() => {
        throw Object.assign(new Error('disk on fire /secret/path'), { srvCode: 'srv.account.somethingNew' });
      }),
    });
    const s = await start(svc);
    const r = await call(s.base, 'GET', '/api/accounts');
    expect(r.status).toBe(500);
    expect(r.text).toBe(JSON.stringify({ ok: false, error: 'SERVER_ERROR' }));
  });
});

describe('AccountsApi maps service errors', () => {
  const cases: Array<[string, number]> = [
    ['NAME_INVALID', 400], ['COLOR_INVALID', 400], ['LETTER_INVALID', 400], ['NOTE_INVALID', 400],
    ['TOKEN_INVALID', 400], ['BAD_REQUEST', 400], ['BUILTIN', 400], ['ACCOUNT_NO_TOKEN', 400],
    ['NOT_FOUND', 404], ['ACCOUNT_UNKNOWN', 404],
    ['CONNECT_BUSY', 409],
    ['PTY_UNAVAILABLE', 503], ['SECRETS_UNAVAILABLE', 503],
  ];
  it.each(cases)('%s -> %i with the code as the error', async (code, status) => {
    const boom = () => {
      throw Object.assign(new Error('internal detail'), { code });
    };
    const svc = fakeService({ view: vi.fn(boom), connect: vi.fn(boom), setDefault: vi.fn(boom) });
    const s = await start(svc);
    const r = await call(s.base, 'GET', '/api/accounts');
    expect(r.status).toBe(status);
    expect(r.json).toEqual({ ok: false, error: code });
    expect(r.text).not.toContain('internal detail');
  });

  it('an async service rejection with a known code is mapped the same way', async () => {
    const svc = fakeService({ remove: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'CONNECT_BUSY' }); }) });
    const s = await start(svc);
    const r = await call(s.base, 'DELETE', '/api/accounts/work');
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ ok: false, error: 'CONNECT_BUSY' });
  });

  it('an unknown code or a plain Error becomes 500 SERVER_ERROR with no message', async () => {
    const unknown = fakeService({ view: vi.fn(() => { throw Object.assign(new Error('disk on fire /secret/path'), { code: 'SOMETHING_ELSE' }); }) });
    const s1 = await start(unknown);
    const r1 = await call(s1.base, 'GET', '/api/accounts');
    expect(r1.status).toBe(500);
    expect(r1.text).toBe(JSON.stringify({ ok: false, error: 'SERVER_ERROR' }));

    const plain = fakeService({ view: vi.fn(() => { throw new Error('disk on fire'); }) });
    const s2 = await start(plain);
    const r2 = await call(s2.base, 'GET', '/api/accounts');
    expect(r2.status).toBe(500);
    expect(r2.text).toBe(JSON.stringify({ ok: false, error: 'SERVER_ERROR' }));
  });

  it('a token that appears in a service error message never reaches the response', async () => {
    const svc = fakeService({
      putToken: vi.fn(async (_id: string, token: string) => {
        throw new Error(`secrets write failed for ${token}`);
      }),
    });
    const s = await start(svc);
    const r = await call(s.base, 'PUT', '/api/accounts/work/token', { body: { token: TOKEN } });
    expect(r.status).toBe(500);
    expect(r.text).toBe(JSON.stringify({ ok: false, error: 'SERVER_ERROR' }));
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).not.toContain('B'.repeat(20));
  });

  it('the token never appears in any response body on the happy paths', async () => {
    const s = await start();
    const responses: Resp[] = [
      await call(s.base, 'PUT', '/api/accounts/work/token', { body: { token: TOKEN } }),
      await call(s.base, 'POST', '/api/accounts/work/check'),
      await call(s.base, 'GET', '/api/accounts'),
      await call(s.base, 'PATCH', '/api/accounts/work', { body: { note: 'n' } }),
      await call(s.base, 'PUT', '/api/accounts/work/token', { body: { token: 'nope' } }),
      await call(s.base, 'PUT', '/api/accounts/work/token', { body: { token: 99 } }),
    ];
    for (const r of responses) {
      expect(r.text).not.toContain(TOKEN);
      expect(r.text).not.toContain('sk-ant-oat01-');
    }
  });
});

// ---- profile passwords: POST /:id/unlock and PUT /:id/password ----

const PASS = 'correct-horse-9';

/** A service whose unlock/setPassword reject with the given code (a CodedError, as AccountService throws them). */
function rejecting(code: string): Partial<Fake> {
  return {
    unlock: vi.fn(async () => {
      throw new CodedError('service text', code);
    }),
    setPassword: vi.fn(async () => {
      throw new CodedError('service text', code);
    }),
  };
}

describe('AccountsApi unlock', () => {
  it('POST /unlock passes the password to the service and answers 200 with the account', async () => {
    const svc = fakeService();
    const s = await start(svc);
    const r = await call(s.base, 'POST', '/api/accounts/work/unlock', { body: { password: PASS } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, account: expect.objectContaining({ id: 'work', locked: false }) });
    expect(svc.unlock).toHaveBeenCalledWith('work', PASS);
    expect(r.text).not.toContain(PASS);
  });

  it.each([
    ['BAD_PASSWORD', 401],
    ['TOO_MANY_TRIES', 429],
    ['PROFILE_LOCKED', 423],
    ['NO_PASSWORD', 400],
    ['NOT_FOUND', 404],
  ])('maps service code %s to %i with only the code in the body', async (code, status) => {
    const s = await start(fakeService(rejecting(code)));
    const r = await call(s.base, 'POST', '/api/accounts/work/unlock', { body: { password: PASS } });
    expect(r.status).toBe(status);
    expect(r.json).toEqual({ ok: false, error: code });
    expect(r.text).not.toContain(PASS);
    expect(r.text).not.toContain('service text');
  });

  it('the runner-side srv.account.locked code maps to 423 PROFILE_LOCKED', async () => {
    const svc = fakeService({
      putToken: vi.fn(async () => {
        throw new CodedError('locked text', 'srv.account.locked');
      }),
    });
    const s = await start(svc);
    const r = await call(s.base, 'PUT', '/api/accounts/work/token', { body: { token: TOKEN } });
    expect(r.status).toBe(423);
    expect(r.json).toEqual({ ok: false, error: 'PROFILE_LOCKED' });
  });

  it('a body without a string password is 400 BAD_REQUEST and the service is not called', async () => {
    const svc = fakeService();
    const s = await start(svc);
    for (const body of [{}, { password: 1234 }, ['x']]) {
      const r = await call(s.base, 'POST', '/api/accounts/work/unlock', { body });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ ok: false, error: 'BAD_REQUEST' });
    }
    const bad = await call(s.base, 'POST', '/api/accounts/work/unlock', { raw: '{"password":' });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ ok: false, error: 'BAD_JSON' });
    expect(svc.unlock).not.toHaveBeenCalled();
  });

  it('a foreign origin is refused with 403 before anything runs', async () => {
    const svc = fakeService();
    const s = await start(svc);
    const r = await call(s.base, 'POST', '/api/accounts/work/unlock', { body: { password: PASS }, origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(svc.unlock).not.toHaveBeenCalled();
  });

  it('an unexpected error that quotes the password becomes 500 SERVER_ERROR without the text', async () => {
    const svc = fakeService({
      unlock: vi.fn(async (_id: string, pw: string) => {
        throw new Error(`cannot decrypt with ${pw}`);
      }),
    });
    const s = await start(svc);
    const r = await call(s.base, 'POST', '/api/accounts/work/unlock', { body: { password: PASS } });
    expect(r.status).toBe(500);
    expect(r.text).toBe(JSON.stringify({ ok: false, error: 'SERVER_ERROR' }));
    expect(r.text).not.toContain(PASS);
  });
});

describe('AccountsApi password', () => {
  it('PUT /password passes current and next to the service and answers 200', async () => {
    const svc = fakeService();
    const s = await start(svc);
    const r = await call(s.base, 'PUT', '/api/accounts/work/password', { body: { current: PASS, next: 'next-pass-1', extra: 'x' } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(svc.setPassword).toHaveBeenCalledWith('work', { current: PASS, next: 'next-pass-1' });
    expect(r.text).not.toContain(PASS);
    expect(r.text).not.toContain('next-pass-1');
  });

  it('PUT /password with only next (set) passes just next', async () => {
    const svc = fakeService();
    const s = await start(svc);
    await call(s.base, 'PUT', '/api/accounts/work/password', { body: { next: 'next-pass-1' } });
    expect(svc.setPassword).toHaveBeenCalledWith('work', { next: 'next-pass-1' });
  });

  it.each([
    ['BAD_PASSWORD', 401],
    ['TOO_MANY_TRIES', 429],
    ['PROFILE_LOCKED', 423],
    ['PASSWORD_INVALID', 400],
    ['NO_PASSWORD', 400],
    ['ACCOUNT_NO_TOKEN', 400],
    ['BUILTIN', 400],
    ['SECRETS_UNAVAILABLE', 503],
  ])('maps service code %s to %i', async (code, status) => {
    const s = await start(fakeService(rejecting(code)));
    const r = await call(s.base, 'PUT', '/api/accounts/work/password', { body: { current: PASS, next: 'next-pass-1' } });
    expect(r.status).toBe(status);
    expect(r.json).toEqual({ ok: false, error: code });
    expect(r.text).not.toContain(PASS);
  });

  it('a non-object body or a non-string field is 400 BAD_REQUEST and the service is not called', async () => {
    const svc = fakeService();
    const s = await start(svc);
    for (const body of [['a'], 'x', { current: 5 }, { next: null }]) {
      const r = await call(s.base, 'PUT', '/api/accounts/work/password', { body });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ ok: false, error: 'BAD_REQUEST' });
    }
    expect(svc.setPassword).not.toHaveBeenCalled();
  });

  it('a foreign origin is refused with 403', async () => {
    const svc = fakeService();
    const s = await start(svc);
    const r = await call(s.base, 'PUT', '/api/accounts/work/password', { body: { next: PASS }, origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(svc.setPassword).not.toHaveBeenCalled();
  });
});
