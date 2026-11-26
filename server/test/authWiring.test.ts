// App lock and main-account login wired into the server: the HTTP guard order, the websocket refusal (close 4401,
// no snapshot, never broadcast to), the cookie after unlock and after a restart, main_login broadcasts, and the
// password never leaving the server. Fakes only: a fake Runner, a fake main service, real AppLock/AccountService on
// temp dirs with a small scrypt cost. No real claude, no pty, no DPAPI.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOCK_CLOSE_CODE, type ServerMsg } from '../../shared/protocol';
import type { MainAccountInfo, MainLoginEvent } from '../../shared/accounts';
import { AccountService, type AccountsStore } from '../src/accounts';
import { AccountsApi } from '../src/accountsApi';
import { AppLock } from '../src/appLock';
import { AuthApi } from '../src/authApi';
import { WorklogDb } from '../src/db';
import type { MainAccountService } from '../src/mainAccount';
import { MainAuthApi } from '../src/mainAuthApi';
import { startServer, type RunningServer } from '../src/index';
import type { ChildLike, Runner } from '../src/runner';
import { Watcher } from '../src/watcher';

// Fake PINs only. Never a real credential.
const PW = '246813';
const WRONG = '135790';
const TEST_N = 1024;
const ORIGIN = 'http://127.0.0.1';
const originAllowed = (o: string | undefined) => o === undefined || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(o);

class FakeRunner extends EventEmitter {
  states() {
    return [];
  }
  accountOf(): string | null {
    return null;
  }
  resumeWaiting(): number {
    return 0;
  }
}

/** Main-account service fake: the info/status/login surface the wiring touches, nothing else. */
class FakeMain extends EventEmitter {
  current: MainAccountInfo | null = null;
  info(): MainAccountInfo | null {
    return this.current;
  }
  async status(): Promise<MainAccountInfo> {
    return this.current as MainAccountInfo;
  }
  login(): void {}
  writeCode(): void {}
  cancelLogin(): boolean {
    return false;
  }
  async logout(): Promise<MainAccountInfo> {
    return this.current as MainAccountInfo;
  }
  dispose(): void {}
}

const tmp: string[] = [];
const dbs: WorklogDb[] = [];
const accountSvcs: AccountService[] = [];
const sockets: WebSocket[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of servers.splice(0)) await s.close();
  for (const a of accountSvcs.splice(0)) a.dispose();
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timed out');
    await tick(5);
  }
}

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-authwire-'));
  tmp.push(d);
  return d;
}

interface Resp {
  status: number;
  text: string;
  json: any;
  setCookie: string | undefined;
}

/** Plain http with an explicit Origin and an optional Cookie header. */
function call(base: string, method: string, urlPath: string, body?: unknown, cookie?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (cookie) headers.Cookie = cookie;
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const u = new URL(urlPath, base);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode ?? 0, text, json, setCookie: Array.isArray(sc) ? sc[0] : sc });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface Opened {
  ws: WebSocket;
  msgs: ServerMsg[];
  raw: string[];
}

/** Connects with an optional Cookie header; resolves on open. */
function connect(port: number, cookie?: string): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    sockets.push(ws);
    const msgs: ServerMsg[] = [];
    const raw: string[] = [];
    ws.on('message', (d) => {
      const text = d.toString();
      raw.push(text);
      msgs.push(JSON.parse(text));
    });
    ws.on('open', () => resolve({ ws, msgs, raw }));
    ws.on('error', reject);
  });
}

/** The ws the app lock refuses: it opens, then the server closes it with 4401 before sending anything. */
async function refused(port: number): Promise<{ code: number; msgs: ServerMsg[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const msgs: ServerMsg[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no close within 3s')), 3000);
    ws.on('close', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
    ws.on('error', () => {
      // a refusal can also surface as an error event; the close still arrives and is awaited above
    });
  });
  return { code, msgs };
}

interface Harness {
  dir: string;
  lock: AppLock;
  accounts: AccountService;
  main: FakeMain;
  base: string;
  port: number;
  logs: string[];
  server: RunningServer;
}

/** A server with an AppLock on `dir`: set with `password` on first use, loaded from the dir otherwise. */
async function boot(opts: { dir?: string; password?: string; withMain?: boolean; logs?: string[] } = {}): Promise<Harness> {
  const dir = opts.dir ?? tmpDir();
  const dbFile = path.join(dir, 'worklog.db');
  const db = new WorklogDb(dbFile);
  dbs.push(db);
  const store = new Map<string, string>();
  const logs: string[] = opts.logs ?? [];
  const main = new FakeMain();
  const accounts = new AccountService({
    db: db as unknown as AccountsStore,
    secrets: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        store.set(k, v);
      },
      clear: async (k) => {
        store.delete(k);
      },
    },
    pty: null,
    spawn: () => new PassThrough() as unknown as ChildLike,
    log: (m) => logs.push(m),
    ...(opts.withMain ? { main: { info: () => main.info() } } : {}),
  });
  await accounts.init();
  accountSvcs.push(accounts);
  const lock = new AppLock({ dir, N: TEST_N });
  if (opts.password !== undefined && !lock.configured()) await lock.set(opts.password);
  const watcher = new Watcher({ claudeDir: path.join(dir, 'claude'), pollMs: 60_000, isPidAlive: () => false });
  const server = await startServer({
    watcher,
    port: 0,
    pingMs: 100_000,
    runner: new FakeRunner() as unknown as Runner,
    accounts,
    accountsApi: new AccountsApi({ originAllowed, accounts }),
    authApi: new AuthApi({ originAllowed, lock }),
    mainAuthApi: new MainAuthApi({ originAllowed, main: main as unknown as MainAccountService }),
    appLock: lock,
    ...(opts.withMain ? { main: main as unknown as MainAccountService } : {}),
    log: (m) => logs.push(typeof m === 'string' ? m : JSON.stringify(m)),
    allowedCwds: () => [dir],
  });
  servers.push(server);
  return { dir, lock, accounts, main, base: `http://127.0.0.1:${server.port}`, port: server.port, logs, server };
}

/** The `cr_session=<sid>` part of a Set-Cookie header (what a browser sends back). */
const cookiePair = (setCookie: string | undefined): string => (setCookie ?? '').split(';')[0];

describe('app lock wiring (HTTP guard order, websocket refusal, cookie across restarts)', () => {
  it('locked and no cookie: /api is 401 LOCKED; auth state, health and the static fallthrough still answer', async () => {
    const h = await boot({ password: PW });
    const api = await call(h.base, 'GET', '/api/accounts');
    expect(api.status).toBe(401);
    expect(api.json).toEqual({ ok: false, error: 'LOCKED' });
    const state = await call(h.base, 'GET', '/api/auth/state');
    expect(state.status).toBe(200);
    expect(state.json).toEqual({ required: true, unlocked: false });
    const health = await call(h.base, 'GET', '/health');
    expect(health.status).toBe(200);
    // not /api and not guarded: the static fallthrough (no staticDir here, so the plain 404 of the server)
    const page = await call(h.base, 'GET', '/index.html');
    expect(page.status).toBe(404);
    expect(page.text).not.toContain('LOCKED');
  });

  it('locked: a websocket with no cookie is closed with 4401 and receives no snapshot', async () => {
    const h = await boot({ password: PW });
    const r = await refused(h.port);
    expect(r.code).toBe(APP_LOCK_CLOSE_CODE);
    expect(r.msgs).toHaveLength(0);
  });

  it('locked: a refused socket never receives a broadcast (accounts change while it is closed)', async () => {
    const h = await boot({ password: PW });
    const r = await refused(h.port);
    h.accounts.create({ name: 'Late' });
    await tick(50);
    expect(r.msgs).toHaveLength(0);
  });

  it('unlock: wrong password is 401 BAD_PASSWORD, right one sets a session cookie that works for HTTP and ws', async () => {
    const h = await boot({ password: PW });
    const bad = await call(h.base, 'POST', '/api/auth/unlock', { password: WRONG });
    expect(bad.status).toBe(401);
    expect(bad.json).toEqual({ ok: false, error: 'BAD_PASSWORD' });
    expect(bad.text).not.toContain(WRONG);

    const good = await call(h.base, 'POST', '/api/auth/unlock', { password: PW });
    expect(good.status).toBe(200);
    expect(good.setCookie).toMatch(/^cr_session=[0-9a-f]{64};/);
    expect(good.setCookie).toContain('HttpOnly');
    expect(good.text).not.toContain(PW);
    const cookie = cookiePair(good.setCookie);

    const api = await call(h.base, 'GET', '/api/accounts', undefined, cookie);
    expect(api.status).toBe(200);
    expect(api.json.defaultId).toBe('terminal');

    const ws = await connect(h.port, cookie);
    await until(() => ws.msgs.some((m) => m.type === 'snapshot'));
    expect(ws.msgs.find((m) => m.type === 'snapshot')).toBeDefined();
  });

  it('a restarted lock (new process, same dir) rejects the old cookie', async () => {
    const dir = tmpDir();
    const first = await boot({ dir, password: PW });
    const good = await call(first.base, 'POST', '/api/auth/unlock', { password: PW });
    const cookie = cookiePair(good.setCookie);
    expect((await call(first.base, 'GET', '/api/accounts', undefined, cookie)).status).toBe(200);

    const restarted = await boot({ dir });
    expect(restarted.lock.configured()).toBe(true);
    const stale = await call(restarted.base, 'GET', '/api/accounts', undefined, cookie);
    expect(stale.status).toBe(401);
    expect(stale.json).toEqual({ ok: false, error: 'LOCKED' });
    const r = await refused(restarted.port);
    expect(r.code).toBe(APP_LOCK_CLOSE_CODE);
  });

  it('no lock configured: everything answers as before (api 200, ws gets the snapshot, no cookie needed)', async () => {
    const h = await boot();
    const api = await call(h.base, 'GET', '/api/accounts');
    expect(api.status).toBe(200);
    const state = await call(h.base, 'GET', '/api/auth/state');
    expect(state.json).toEqual({ required: false, unlocked: true });
    const ws = await connect(h.port);
    await until(() => ws.msgs.some((m) => m.type === 'snapshot'));
    expect(ws.msgs.find((m) => m.type === 'snapshot')).toBeDefined();
  });
});

describe('main login wiring (main_login broadcast, fake main service only)', () => {
  it('a main login event reaches a connected ws client as main_login', async () => {
    const h = await boot({ withMain: true });
    const ws = await connect(h.port);
    await until(() => ws.msgs.some((m) => m.type === 'snapshot'));
    const ev: MainLoginEvent = { status: 'waiting_browser', url: 'https://claude.ai/oauth/authorize?x=1', needCode: true };
    h.main.emit('login', ev);
    await until(() => ws.msgs.some((m) => m.type === 'main_login'));
    const m = ws.msgs.find((x) => x.type === 'main_login') as Extract<ServerMsg, { type: 'main_login' }>;
    expect(m.event).toEqual(ev);
    expect(typeof m.serverTime).toBe('number');
  });

  it('close() unsubscribes the main login broadcast (no listener left on the main service)', async () => {
    const h = await boot({ withMain: true });
    expect(h.main.listenerCount('login')).toBe(1);
    await h.server.close();
    servers.splice(servers.indexOf(h.server), 1);
    expect(h.main.listenerCount('login')).toBe(0);
  });
});

describe('password secrecy on the wire and in the log', () => {
  it('the app password appears in no ws frame, no log line and no HTTP body', async () => {
    const logs: string[] = [];
    const h = await boot({ password: PW, withMain: true, logs });
    const bad = await call(h.base, 'POST', '/api/auth/unlock', { password: WRONG });
    const good = await call(h.base, 'POST', '/api/auth/unlock', { password: PW });
    const cookie = cookiePair(good.setCookie);
    const ws = await connect(h.port, cookie);
    await until(() => ws.msgs.some((m) => m.type === 'snapshot'));
    h.accounts.create({ name: 'Work' });
    await tick(50);
    for (const frame of ws.raw) expect(frame).not.toContain(PW);
    for (const line of logs) expect(line).not.toContain(PW);
    expect(bad.text).not.toContain(PW);
    expect(good.text).not.toContain(PW);
    // the lock file never stores the password itself
    const cfg = fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8');
    expect(cfg).not.toContain(PW);
  });
});
