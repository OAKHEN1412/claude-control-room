// Account profiles wired into the server: snapshot fields, set_account / start with accountId, the accounts
// broadcast after an HTTP create, per-profile usage from rate_limit_event, /api/accounts ordering, and the token
// leak check. Fakes only: a fake Runner, a fake spawn for the token check, no pty, temp files.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountsView, MainAccountInfo } from '../../shared/accounts';
import type { ServerMsg } from '../../shared/protocol';
import { AccountService, type AccountsStore } from '../src/accounts';
import type { MainAccountService } from '../src/mainAccount';
import { AccountsApi } from '../src/accountsApi';
import { ClipApi } from '../src/api';
import { WorklogDb } from '../src/db';
import { startServer, type RunningServer } from '../src/index';
import { UsageService } from '../src/usage';
import { CommandError, type ChildLike, type Runner } from '../src/runner';
import { Watcher } from '../src/watcher';

// Fake token, shaped like a real one so the leak checks mean something. Never a real credential.
const TOKEN = 'sk-ant-oat01-' + 'C'.repeat(80);
const ORIGIN = 'http://127.0.0.1';

/** A child for the token check: prints nothing and exits 1 (the check then reports not-ok; nothing is stored). */
class CheckChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  constructor() {
    super();
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('close', 1, null);
    });
  }
  kill(): boolean {
    this.emit('close', null, 'SIGTERM');
    return true;
  }
}

/** The Runner methods startServer and its ws path use; everything else is absent on purpose. */
class FakeRunner extends EventEmitter {
  accountOfMap = new Map<string, string>();
  setAccountCalls: [string, string][] = [];
  startCalls: Record<string, unknown>[] = [];
  setAccountError: Error | null = null;
  states() {
    return [];
  }
  start(req: Record<string, unknown>): string {
    this.startCalls.push(req);
    return 'sess-started';
  }
  async setAccount(sessionId: string, accountId: string): Promise<'done'> {
    this.setAccountCalls.push([sessionId, accountId]);
    if (this.setAccountError) throw this.setAccountError;
    return 'done';
  }
  accountOf(sessionId: string): string | null {
    return this.accountOfMap.get(sessionId) ?? null;
  }
  resumeCalls: string[] = [];
  resumeWaiting(accountId: string): number {
    this.resumeCalls.push(accountId);
    return 1;
  }
}

/** The main-account service as startServer and AccountService see it: info() plus a 'status' event. */
class FakeMain extends EventEmitter {
  current: MainAccountInfo | null = null;
  info(): MainAccountInfo | null {
    return this.current;
  }
  async status(): Promise<MainAccountInfo> {
    return this.current as MainAccountInfo;
  }
  dispose(): void {}
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timed out');
    await tick(5);
  }
}

const tmp: string[] = [];
const dbs: WorklogDb[] = [];
let server: RunningServer | null = null;
let watcher: Watcher | null = null;
let sockets: WebSocket[] = [];
let httpServers: http.Server[] = [];
const accountSvcs: AccountService[] = [];

beforeEach(() => {
  server = null;
  watcher = null;
  sockets = [];
  httpServers = [];
});

afterEach(async () => {
  for (const ws of sockets) ws.terminate();
  if (server) await server.close();
  for (const s of httpServers) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  // dispose before the database closes, so no deferred emit can reach a closed db
  for (const a of accountSvcs.splice(0)) a.dispose();
  for (const db of dbs.splice(0)) db.close();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-acct-wiring-'));
  tmp.push(d);
  return d;
}

interface Harness {
  dir: string;
  db: WorklogDb;
  accounts: AccountService;
  runner: FakeRunner;
  usage: UsageService;
  ingest: ReturnType<typeof vi.fn>;
  logs: string[];
  spawnCalls: { env: NodeJS.ProcessEnv }[];
  base: string;
  port: number;
}

/** Boots startServer with a real AccountService (temp SQLite file, fake secrets, no pty, fake spawn) and a fake Runner. */
async function boot(opts: { withClipApi?: boolean; main?: FakeMain } = {}): Promise<Harness> {
  const dir = tmpDir();
  const dbFile = path.join(dir, 'worklog.db');
  const db = new WorklogDb(dbFile);
  dbs.push(db);
  const store = new Map<string, string>();
  const logs: string[] = [];
  const spawnCalls: { env: NodeJS.ProcessEnv }[] = [];
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
    spawn: (_cmd, _args, o) => {
      spawnCalls.push({ env: o.env });
      return new CheckChild() as unknown as ChildLike;
    },
    checkTimeoutMs: 5000,
    log: (m) => logs.push(m),
    ...(opts.main ? { main: { info: () => opts.main!.info() } } : {}),
  });
  await accounts.init();
  accountSvcs.push(accounts);
  const runner = new FakeRunner();
  const usage = new UsageService({ dir: path.join(dir, 'usage-state'), pollMs: 60_000 });
  const ingest = vi.spyOn(usage, 'ingest') as unknown as ReturnType<typeof vi.fn>;
  watcher = new Watcher({ claudeDir: path.join(dir, 'claude'), pollMs: 60_000, isPidAlive: () => false });
  const originAllowed = (o: string | undefined) => o === undefined || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(o);
  const accountsApi = new AccountsApi({ originAllowed, accounts });
  // ClipApi answers every other /api/ path; the accounts route must win over it.
  const clipApi = opts.withClipApi ? new ClipApi({ originAllowed, lemoFile: path.join(dir, 'no-lemo.json') }) : undefined;
  server = await startServer({
    watcher,
    port: 0,
    pingMs: 100_000,
    runner: runner as unknown as Runner,
    accounts,
    accountsApi,
    ...(opts.main ? { main: opts.main as unknown as MainAccountService } : {}),
    usage,
    api: clipApi,
    log: (m) => logs.push(typeof m === 'string' ? m : JSON.stringify(m)),
    allowedCwds: () => [dir],
  });
  return { dir, db, accounts, runner, usage, ingest, logs, spawnCalls, base: `http://127.0.0.1:${server.port}`, port: server.port };
}

interface Connected {
  ws: WebSocket;
  msgs: ServerMsg[];
  raw: string[];
}

function connect(port: number): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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

const ackFor = async (msgs: ServerMsg[], reqId: string) => {
  await until(() => msgs.some((m) => m.type === 'ack' && m.reqId === reqId));
  return msgs.find((m) => m.type === 'ack' && m.reqId === reqId) as Extract<ServerMsg, { type: 'ack' }>;
};

interface Resp {
  status: number;
  text: string;
  json: any;
}

/** Plain http with an explicit Origin header (node fetch may not send one). */
function call(base: string, method: string, urlPath: string, body?: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Origin: ORIGIN };
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
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('accounts wiring (snapshot, ws commands, broadcasts, usage, routes, leaks)', () => {
  it('snapshot carries the profiles (terminal first) and the default id', async () => {
    const h = await boot();
    const work = h.accounts.create({ name: 'Work' });
    const { msgs } = await connect(h.port);
    await until(() => msgs.some((m) => m.type === 'snapshot'));
    const snap = msgs.find((m) => m.type === 'snapshot') as Extract<ServerMsg, { type: 'snapshot' }>;
    expect(snap.accounts?.map((a) => a.id)).toEqual(['terminal', work.id]);
    expect(snap.accounts?.[0].builtin).toBe(true);
    expect(snap.defaultAccountId).toBe('terminal');
    expect(snap.ptyAvailable).toBe(false);
  });

  it('set_account reaches runner.setAccount and acks ok', async () => {
    const h = await boot();
    const work = h.accounts.create({ name: 'Work' });
    const { ws, msgs } = await connect(h.port);
    ws.send(JSON.stringify({ type: 'set_account', reqId: 'r1', sessionId: 's1', accountId: work.id }));
    const ack = await ackFor(msgs, 'r1');
    expect(ack.ok).toBe(true);
    expect(ack.sessionId).toBe('s1');
    expect(h.runner.setAccountCalls).toEqual([['s1', work.id]]);
  });

  it('start with accountId reaches runner.start with it', async () => {
    const h = await boot();
    const work = h.accounts.create({ name: 'Work' });
    const { ws, msgs } = await connect(h.port);
    ws.send(JSON.stringify({ type: 'start', reqId: 'st1', cwd: h.dir, model: 'haiku', effort: 'low', prompt: 'hi', accountId: work.id }));
    const ack = await ackFor(msgs, 'st1');
    expect(ack.ok).toBe(true);
    expect(ack.sessionId).toBe('sess-started');
    expect(h.runner.startCalls).toHaveLength(1);
    expect(h.runner.startCalls[0].accountId).toBe(work.id);
  });

  it('a CommandError from setAccount acks ok:false with its message and code', async () => {
    const h = await boot();
    const work = h.accounts.create({ name: 'Work' });
    h.runner.setAccountError = new CommandError('no token loaded', 'srv.account.noToken');
    const { ws, msgs } = await connect(h.port);
    ws.send(JSON.stringify({ type: 'set_account', reqId: 'r2', sessionId: 's2', accountId: work.id }));
    const ack = await ackFor(msgs, 'r2');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('no token loaded');
    expect(ack.code).toBe('srv.account.noToken');
  });

  it('creating a profile over HTTP broadcasts accounts to a connected ws client', async () => {
    const h = await boot();
    const { msgs } = await connect(h.port);
    await until(() => msgs.some((m) => m.type === 'snapshot'));
    const res = await call(h.base, 'POST', '/api/accounts', { name: 'Beta' });
    expect(res.status).toBe(201);
    expect(res.json.ok).toBe(true);
    await until(() => msgs.some((m) => m.type === 'accounts' && (m as Extract<ServerMsg, { type: 'accounts' }>).accounts.some((a) => a.name === 'Beta')));
    const b = msgs.filter((m): m is Extract<ServerMsg, { type: 'accounts' }> => m.type === 'accounts').pop()!;
    expect(b.defaultId).toBe('terminal');
    expect(b.ptyAvailable).toBe(false);
  });

  it('rate_limit_event from a session of a profile updates that profile usage', async () => {
    const h = await boot();
    const work = h.accounts.create({ name: 'Work' });
    h.runner.accountOfMap.set('s9', work.id);
    h.runner.emit('stream_event', 's9', {
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } },
    });
    const pctOf = () => Math.round(h.accounts.view().accounts.find((a) => a.id === work.id)?.usage?.sevenDay?.pct ?? -1);
    await until(() => pctOf() === 42);
    expect(pctOf()).toBe(42);
  });

  it('a rate_limit_event of a token job updates that profile only, not the global header quota', async () => {
    const h = await boot();
    const work = h.accounts.create({ name: 'Work' });
    h.runner.accountOfMap.set('s-token', work.id);
    h.runner.accountOfMap.set('s-term', 'terminal');
    const event = {
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } },
    };
    h.runner.emit('stream_event', 's-token', event);
    const pctOf = () => Math.round(h.accounts.view().accounts.find((a) => a.id === work.id)?.usage?.sevenDay?.pct ?? -1);
    await until(() => pctOf() === 42);
    // the global snapshot never saw the token job's quota, and ingest was not called for that event
    expect(h.usage.snapshot().sevenDay).toBeNull();
    expect(h.ingest).not.toHaveBeenCalledWith('s-token', event);

    // a terminal-session rate_limit_event still reaches ingest
    const termEvent = { ...event, rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.13, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } };
    h.runner.emit('stream_event', 's-term', termEvent);
    expect(h.ingest).toHaveBeenCalledWith('s-term', termEvent);
    expect(h.usage.snapshot().sevenDay?.pct).toBeCloseTo(13, 5);
    // and the profile's own usage is unchanged by the terminal session
    expect(Math.round(pctOf())).toBe(42);
  });

  it('an assistant event of a token job still reaches ingest (only its rate_limit_event is kept from the global quota)', async () => {
    const h = await boot();
    const work = h.accounts.create({ name: 'Work' });
    h.runner.accountOfMap.set('s-token', work.id);
    const assistant = { type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 5 } } };
    h.runner.emit('stream_event', 's-token', assistant);
    expect(h.ingest).toHaveBeenCalledWith('s-token', assistant);
  });

  it('/api/accounts is answered by the accounts route, not by ClipApi', async () => {
    const h = await boot({ withClipApi: true });
    h.accounts.create({ name: 'Work' });
    const res = await call(h.base, 'GET', '/api/accounts');
    expect(res.status).toBe(200);
    const view = res.json as AccountsView;
    expect(view.defaultId).toBe('terminal');
    expect(view.accounts.map((a) => a.id)).toContain('terminal');
  });

  it('LEAK: a token PUT through the API appears in no ws frame, no log line and no SQLite file bytes', async () => {
    const h = await boot();
    const work = h.accounts.create({ name: 'Work' });
    const { msgs, raw } = await connect(h.port);
    await until(() => msgs.some((m) => m.type === 'snapshot'));

    const put = await call(h.base, 'PUT', `/api/accounts/${work.id}/token`, { token: TOKEN });
    expect(put.status).toBe(200);
    expect(put.text).not.toContain(TOKEN);
    // the check ran as the profile: the token is in the child env (the one place it is allowed) and nowhere else
    await until(() => h.spawnCalls.length === 1);
    expect(h.spawnCalls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    await until(() => h.accounts.view().accounts.find((a) => a.id === work.id)?.lastCheckAt !== null);
    await tick(50);

    // every frame the client received
    for (const frame of raw) expect(frame).not.toContain(TOKEN);
    // every log line handed to the log option (server and service)
    for (const line of h.logs) expect(line).not.toContain(TOKEN);
    // every byte of the database directory (main file, -wal and -shm included)
    for (const name of fs.readdirSync(h.dir)) {
      const file = path.join(h.dir, name);
      if (!fs.statSync(file).isFile()) continue;
      expect(fs.readFileSync(file).indexOf(TOKEN)).toBe(-1);
    }
  });
});

describe('main account and unlock wiring (view, status broadcast, resume on unlock, routes)', () => {
  it('the terminal entry of the view carries the main account info from the main service', async () => {
    const main = new FakeMain();
    main.current = { loggedIn: true, email: 'someone@example.com', plan: 'max', orgName: 'Org', expiresAt: null, checkedAt: 1 };
    const h = await boot({ main });
    const term = h.accounts.view().accounts.find((a) => a.id === 'terminal');
    expect(term?.main).toEqual(main.current);
  });

  it('a main-service status event broadcasts accounts to a connected ws client', async () => {
    const main = new FakeMain();
    const h = await boot({ main });
    main.on('status', () => h.accounts.notifyChanged());
    const { msgs } = await connect(h.port);
    await until(() => msgs.some((m) => m.type === 'snapshot'));
    main.current = { loggedIn: false, email: null, plan: null, orgName: null, expiresAt: null, checkedAt: 2 };
    main.emit('status', main.current);
    await until(() => msgs.some((m) => m.type === 'accounts' && (m as Extract<ServerMsg, { type: 'accounts' }>).accounts.find((a) => a.id === 'terminal')?.main?.checkedAt === 2));
  });

  it('an unlock event resumes the waiting jobs of that profile once', async () => {
    const h = await boot();
    const work = h.accounts.create({ name: 'Work' });
    h.accounts.on('unlocked', (id: string) => h.runner.resumeWaiting(id));
    h.accounts.emit('unlocked', work.id);
    expect(h.runner.resumeCalls).toEqual([work.id]);
  });

  it('GET /api/accounts/main is answered by the main auth api, not by the accounts api', async () => {
    const main = new FakeMain();
    main.current = { loggedIn: false, email: null, plan: null, orgName: null, expiresAt: null, checkedAt: 3 };
    const h = await boot({ main });
    const statusSpy = vi.fn(async () => main.current as MainAccountInfo);
    // a fake MainAuthApi in front of the accounts route: it must see the request
    const seen: string[] = [];
    const mainApi = {
      handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
        if (req.url !== '/api/accounts/main') return false;
        seen.push(req.url);
        void statusSpy();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ loggedIn: false, marker: 'main-api' }));
        return true;
      },
    };
    await server?.close();
    server = await startServer({
      watcher: watcher!,
      port: 0,
      pingMs: 100_000,
      runner: h.runner as unknown as Runner,
      accounts: h.accounts,
      accountsApi: new AccountsApi({ originAllowed: (o) => o === undefined || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(o), accounts: h.accounts }),
      mainAuthApi: mainApi as unknown as import('../src/mainAuthApi').MainAuthApi,
      log: () => {},
    });
    const res = await call(`http://127.0.0.1:${server.port}`, 'GET', '/api/accounts/main');
    expect(res.status).toBe(200);
    expect(res.json.marker).toBe('main-api');
    expect(seen).toEqual(['/api/accounts/main']);
    expect(statusSpy).toHaveBeenCalledTimes(1);
  });
});

