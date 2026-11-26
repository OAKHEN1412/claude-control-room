// AccountService: profiles, tokens, the claude -p health check, the setup-token capture and usage.
// Fakes only: a Map-backed secret store, a fake spawn, a fake pty and screen, a real WorklogDb on a temp sqlite file.
// No real claude, no real pty, no real ~/.claude.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_COLORS, type AccountInfo, type ConnectEvent, type MainAccountInfo } from '../../shared/accounts';
import { AccountService, type AccountServiceDeps } from '../src/accounts';
import type { ChildLike } from '../src/runner';
import { CommandError } from '../src/runner';
import type { PtyFactory, PtyProcess, ScreenLike } from '../src/accountPty';
import { WorklogDb } from '../src/db';

const TOKEN = 'sk-ant-oat01-' + 'LeakTest0123456789_-'.repeat(4);
const TOKEN2 = 'sk-ant-oat01-' + 'Second0123456789_-AbCdEf'.repeat(3);
const TOKEN_FP = createHash('sha256').update(TOKEN).digest('hex').slice(0, 8);
const OK_OUT = JSON.stringify({ type: 'result', is_error: false, result: 'ok' });
const CHECK_ARGS_EXPECTED = [
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

// ---- fakes ----

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  kill = vi.fn(() => true);
}

interface SpawnCall {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

type SpawnReply = { code: number | null; out: string } | 'hang';

/** Fake spawn: each call records argv/env and answers with `respond(n)` (stdout + exit code), or never answers. */
function fakeSpawn(respond: (n: number) => SpawnReply = () => ({ code: 0, out: OK_OUT })) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const fn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildLike => {
    const n = calls.length;
    calls.push({ cmd, args: [...args], env: { ...opts.env }, cwd: opts.cwd });
    const c = new FakeChild();
    children.push(c);
    const r = respond(n);
    if (r !== 'hang') {
      setImmediate(() => {
        c.stdout.once('end', () => c.emit('close', r.code));
        c.stdout.end(r.out);
        c.stderr.end();
      });
    }
    return c as unknown as ChildLike;
  };
  return { fn, calls, children };
}

/** Fake pty: the test pushes screen data and exit through the captured callbacks. */
class FakePty implements PtyProcess {
  pid = 777;
  kill = vi.fn();
  write = vi.fn();
  dataCb: ((d: string) => void) | null = null;
  exitCb: ((e: { exitCode: number }) => void) | null = null;
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }
  push(d: string): void {
    this.dataCb?.(d);
  }
  exit(code = 1): void {
    this.exitCb?.({ exitCode: code });
  }
}

/** Fake screen: the test sets `text` (the rendered logical lines). */
class FakeScreen implements ScreenLike {
  text: string[] = [];
  write(_data: string, cb: () => void): void {
    cb();
  }
  lines(): string[] {
    return this.text;
  }
  dispose(): void {
    // nothing to free
  }
}

// ---- harness ----

let dir: string;
let db: WorklogDb;
let clock: number;
let secretStore: Map<string, string>;
let secrets: {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
};
let logs: string[];
const services: AccountService[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-accounts-svc-'));
  db = new WorklogDb(path.join(dir, 'test.db'));
  clock = 1_800_000_000_000;
  secretStore = new Map();
  secrets = {
    get: vi.fn(async (k: string) => secretStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      secretStore.set(k, v);
    }),
    clear: vi.fn(async (k: string) => {
      secretStore.delete(k);
    }),
  };
  logs = [];
});

afterEach(() => {
  // every service made by make() is disposed before its database closes: no timer can fire on a closed db
  for (const s of services.splice(0)) s.dispose();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Harness {
  svc: AccountService;
  sp: ReturnType<typeof fakeSpawn>;
  pty: FakePty;
  screen: FakeScreen;
  ptyFactoryCalls: () => number;
  changes: AccountsSnapshot[];
  connects: ConnectEvent[];
}
type AccountsSnapshot = ReturnType<AccountService['view']>;

function make(over: Partial<AccountServiceDeps> & { spawnReply?: (n: number) => SpawnReply; noPty?: boolean } = {}): Harness {
  const sp = fakeSpawn(over.spawnReply);
  const pty = new FakePty();
  const screen = new FakeScreen();
  let factoryCalls = 0;
  const factory: PtyFactory = () => {
    factoryCalls++;
    return pty;
  };
  const svc = new AccountService({
    db,
    secrets,
    now: () => clock,
    spawn: sp.fn,
    claudeBin: '/fake/claude',
    pty: over.noPty ? null : factory,
    screen: () => screen,
    log: (m) => logs.push(m),
    checkTimeoutMs: over.checkTimeoutMs ?? 2000,
    connectTimeoutMs: over.connectTimeoutMs ?? 5000,
    ...(over.claudeBin ? { claudeBin: over.claudeBin } : {}),
    ...(over.main ? { main: over.main } : {}),
    ...(over.scryptN !== undefined ? { scryptN: over.scryptN } : {}),
  });
  services.push(svc);
  const changes: AccountsSnapshot[] = [];
  const connects: ConnectEvent[] = [];
  svc.on('change', (v: AccountsSnapshot) => changes.push(v));
  svc.on('connect', (e: ConnectEvent) => connects.push(e));
  return { svc, sp, pty, screen, ptyFactoryCalls: () => factoryCalls, changes, connects };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The srvCode of a thrown error, or undefined. */
function codeOfThrown(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { srvCode?: string }).srvCode;
  }
  return undefined;
}

async function codeOfRejected(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { srvCode?: string }).srvCode;
  }
  return undefined;
}

const RATE_EVENT = {
  type: 'rate_limit_event',
  rate_limit_info: {
    unifiedWindows: {
      five_hour: { utilization: 0.67, resetsAt: 1795408200 },
      seven_day: { utilization: 0.07, resetsAt: 1795986000 },
    },
  },
};

// ---- create / patch / remove / default ----

describe('create', () => {
  it('derives the id from the name, the letter and the first colour', () => {
    const { svc } = make();
    const a = svc.create({ name: 'Work Account' });
    expect(a.id).toBe('work-account');
    expect(a.letter).toBe('WA');
    expect(a.color).toBe(ACCOUNT_COLORS[0]);
    expect(a.tokenState).toBe('unset');
    expect(a.fingerprint).toBeNull();
    expect(a.builtin).toBe(false);
  });

  it('suffixes duplicate ids and never uses a reserved id', () => {
    const { svc } = make();
    expect(svc.create({ name: 'Work' }).id).toBe('work');
    expect(svc.create({ name: 'Work' }).id).toBe('work-2');
    expect(svc.create({ name: 'Work' }).id).toBe('work-3');
    expect(svc.create({ name: 'Terminal' }).id).toBe('terminal-2');
    expect(svc.create({ name: 'default' }).id).toBe('default-2');
  });

  it('falls back to a random a-<hex> id when the name has no latin letters or digits', () => {
    const { svc } = make();
    const a = svc.create({ name: 'สมชาย' });
    expect(a.id).toMatch(/^a-[0-9a-f]{6}$/);
    expect(a.letter).toBe('ส');
  });

  it('cycles the default colour through ACCOUNT_COLORS and honours an explicit one', () => {
    const { svc } = make();
    const colors = [0, 1, 2].map((i) => svc.create({ name: 'n' + i }).color);
    expect(colors).toEqual([ACCOUNT_COLORS[0], ACCOUNT_COLORS[1], ACCOUNT_COLORS[2]]);
    expect(svc.create({ name: 'pink', color: ACCOUNT_COLORS[5] }).color).toBe(ACCOUNT_COLORS[5]);
  });

  it('refuses invalid input with the validation code', () => {
    const { svc } = make();
    expect(codeOfThrown(() => svc.create({ name: '   ' }))).toBe('NAME_INVALID');
    expect(codeOfThrown(() => svc.create({ name: 'x'.repeat(41) }))).toBe('NAME_INVALID');
    expect(codeOfThrown(() => svc.create({ name: 'ok', color: '#000000' }))).toBe('COLOR_INVALID');
    expect(codeOfThrown(() => svc.create({ name: 'ok', letter: 'ABC' }))).toBe('LETTER_INVALID');
    expect(codeOfThrown(() => svc.create({ name: 'ok', note: 'n'.repeat(81) }))).toBe('NOTE_INVALID');
  });

  it('emits change', () => {
    const { svc, changes } = make();
    svc.create({ name: 'A' });
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.at(-1)?.accounts.map((a) => a.id)).toContain('a');
  });
});

describe('patch', () => {
  it('changes the given fields only and emits change', () => {
    const { svc, changes } = make();
    svc.create({ name: 'Acme', note: 'old' });
    const before = changes.length;
    const a = svc.patch('acme', { name: '  Acme   Two ', note: 'new', letter: 'x' });
    expect(a.name).toBe('Acme Two');
    expect(a.note).toBe('new');
    expect(a.letter).toBe('X');
    expect(changes.length).toBeGreaterThan(before);
  });

  it('hides and shows a row without touching the token', () => {
    const { svc } = make();
    svc.create({ name: 'Acme' });
    expect(svc.patch('acme', { hidden: true }).hidden).toBe(true);
    expect(svc.patch('acme', { hidden: false }).hidden).toBe(false);
  });

  it('returns NOT_FOUND for an unknown id and the validation code for a bad value', () => {
    const { svc } = make();
    expect(codeOfThrown(() => svc.patch('nope', { name: 'x' }))).toBe('NOT_FOUND');
    svc.create({ name: 'Acme' });
    expect(codeOfThrown(() => svc.patch('acme', { color: '#123456' }))).toBe('COLOR_INVALID');
  });

  it('allows only hidden on the Terminal profile; anything else is BUILTIN', () => {
    const { svc } = make();
    expect(codeOfThrown(() => svc.patch('terminal', { name: 'Other' }))).toBe('BUILTIN');
    expect(codeOfThrown(() => svc.patch('terminal', { note: 'x' }))).toBe('BUILTIN');
    const t = svc.patch('terminal', { hidden: true });
    expect(t.hidden).toBe(true);
    expect(svc.view().accounts[0].hidden).toBe(true);
    expect(svc.patch('terminal', { hidden: false }).hidden).toBe(false);
  });
});

describe('view', () => {
  it('lists the built-in Terminal profile first, with no token state and ptyAvailable from the factory', () => {
    const { svc } = make();
    svc.create({ name: 'Acme' });
    const v = svc.view();
    expect(v.defaultId).toBe('terminal');
    expect(v.ptyAvailable).toBe(true);
    const t = v.accounts[0];
    expect(t).toMatchObject({ id: 'terminal', name: 'Main account', letter: 'T', builtin: true, tokenState: 'unset', color: ACCOUNT_COLORS[4], locked: false, hasPassword: false });
    expect(t).not.toHaveProperty('main');
    expect(v.accounts.map((a) => a.id)).toEqual(['terminal', 'acme']);
  });

  it('reports ptyAvailable false when the factory is null', () => {
    const { svc } = make({ noPty: true });
    expect(svc.view().ptyAvailable).toBe(false);
  });
});

describe('remove and default', () => {
  it('clears the secret, deletes the row and drops the default back to terminal', async () => {
    const { svc } = make({ spawnReply: () => ({ code: 0, out: OK_OUT }) });
    svc.create({ name: 'Acme' });
    await svc.putToken('acme', TOKEN);
    svc.setDefault('acme');
    expect(svc.defaultId()).toBe('acme');
    await svc.remove('acme');
    expect(secrets.clear).toHaveBeenCalledWith('account:acme');
    expect(secretStore.has('account:acme')).toBe(false);
    expect(svc.exists('acme')).toBe(false);
    expect(svc.defaultId()).toBe('terminal');
    expect(svc.view().accounts.map((a) => a.id)).toEqual(['terminal']);
  });

  it('still removes the row when the secret clear fails', async () => {
    const { svc } = make();
    svc.create({ name: 'Acme' });
    secrets.clear.mockRejectedValueOnce(new Error('vault down'));
    await svc.remove('acme');
    expect(svc.exists('acme')).toBe(false);
  });

  it('refuses to remove the Terminal profile and unknown ids', async () => {
    const { svc } = make();
    await expect(svc.remove('terminal')).rejects.toMatchObject({ srvCode: 'BUILTIN' });
    await expect(svc.remove('ghost')).rejects.toMatchObject({ srvCode: 'NOT_FOUND' });
  });

  it('setDefault accepts terminal and existing rows, refuses unknown ids', () => {
    const { svc } = make();
    svc.create({ name: 'Acme' });
    svc.setDefault('acme');
    expect(svc.defaultId()).toBe('acme');
    svc.setDefault('terminal');
    expect(svc.defaultId()).toBe('terminal');
    expect(codeOfThrown(() => svc.setDefault('ghost'))).toBe('NOT_FOUND');
  });

  it('nameOf falls back to the id for an unknown profile', () => {
    const { svc } = make();
    svc.create({ name: 'Acme Co' });
    expect(svc.nameOf('terminal')).toBe('Main account');
    expect(svc.nameOf('acme-co')).toBe('Acme Co');
    expect(svc.nameOf('ghost')).toBe('ghost');
    expect(svc.exists('ghost')).toBe(false);
  });
});

// ---- tokens and the health check ----

describe('putToken', () => {
  it('rejects a malformed token with TOKEN_INVALID and a message that does not echo it', async () => {
    const { svc, sp } = make();
    svc.create({ name: 'Acme' });
    const bad = 'sk-ant-oat01-short-LeakProbe';
    let message = '';
    try {
      await svc.putToken('acme', bad);
    } catch (e) {
      message = (e as Error).message;
      expect((e as { srvCode?: string }).srvCode).toBe('TOKEN_INVALID');
    }
    expect(message).not.toContain('LeakProbe');
    expect(secrets.set).not.toHaveBeenCalled();
    expect(sp.calls).toHaveLength(0);
  });

  it('stores the token under account:<id>, the fingerprint, tokenAt, then runs the check as that token', async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-should-not-leak';
    try {
      const { svc, sp } = make();
      svc.create({ name: 'Acme' });
      clock = 1_800_000_500_000;
      const a = await svc.putToken('acme', TOKEN);
      expect(secrets.set).toHaveBeenCalledWith('account:acme', TOKEN);
      expect(a.tokenState).toBe('set');
      expect(a.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(a.fingerprint).toBe(TOKEN_FP);
      expect(a.tokenAt).toBe(1_800_000_500_000);
      expect(a.expiresAt).toBe(1_800_000_500_000 + 365 * 24 * 3600_000);
      expect(a.lastCheckOk).toBe(true);
      expect(sp.calls).toHaveLength(1);
      const call = sp.calls[0];
      expect(call.cmd).toBe('/fake/claude');
      expect(call.args).toEqual(CHECK_ARGS_EXPECTED);
      expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
      expect('ANTHROPIC_API_KEY' in call.env).toBe(false);
      expect('ANTHROPIC_AUTH_TOKEN' in call.env).toBe(false);
      expect(call.cwd).toBe(os.tmpdir());
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it('returns SECRETS_UNAVAILABLE and records no fingerprint when the secret store fails', async () => {
    const { svc } = make();
    svc.create({ name: 'Acme' });
    secrets.set.mockRejectedValueOnce(new Error('dpapi refused'));
    await expect(svc.putToken('acme', TOKEN)).rejects.toMatchObject({ srvCode: 'SECRETS_UNAVAILABLE' });
    expect(svc.view().accounts[1].tokenState).toBe('unset');
  });

  it('a profile deleted during the secret write gives NOT_FOUND and leaves no secret behind', async () => {
    const { svc } = make();
    svc.create({ name: 'Acme' });
    secrets.set.mockImplementationOnce(async (k: string, v: string) => {
      secretStore.set(k, v);
      db.deleteAccount('acme'); // the profile disappears while the token is being stored
    });
    await expect(svc.putToken('acme', TOKEN)).rejects.toMatchObject({ srvCode: 'NOT_FOUND' });
    expect(secrets.clear).toHaveBeenCalledWith('account:acme');
    expect(secretStore.has('account:acme')).toBe(false);
  });

  it('refuses the Terminal profile and unknown ids', async () => {
    const { svc } = make();
    await expect(svc.putToken('terminal', TOKEN)).rejects.toMatchObject({ srvCode: 'BUILTIN' });
    await expect(svc.putToken('ghost', TOKEN)).rejects.toMatchObject({ srvCode: 'NOT_FOUND' });
  });
});

describe('check', () => {
  it('is ok for exit 0 and a JSON object without is_error', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    expect(h.svc.view().accounts[1].lastCheckOk).toBe(true);
    expect(h.svc.view().accounts[1].lastCheckAt).toBe(clock);
  });

  it('is not ok when the JSON reports is_error true', async () => {
    const h = make({ spawnReply: () => ({ code: 0, out: JSON.stringify({ is_error: true, result: 'Invalid API key' }) }) });
    h.svc.create({ name: 'Acme' });
    const a = await h.svc.putToken('acme', TOKEN);
    expect(a.lastCheckOk).toBe(false);
  });

  it('is not ok for a non-zero exit, for unparseable stdout, and for a spawn error', async () => {
    const exit1 = make({ spawnReply: () => ({ code: 1, out: OK_OUT }) });
    exit1.svc.create({ name: 'A' });
    expect((await exit1.svc.putToken('a', TOKEN)).lastCheckOk).toBe(false);

    const junk = make({ spawnReply: () => ({ code: 0, out: 'not json at all' }) });
    junk.svc.create({ name: 'B' });
    expect((await junk.svc.putToken('b', TOKEN)).lastCheckOk).toBe(false);

    const boom = make();
    boom.svc.create({ name: 'C' });
    await boom.svc.putToken('c', TOKEN);
    (boom.svc as unknown as { spawnFn: unknown }).spawnFn = () => {
      throw new Error('ENOENT claude');
    };
    expect((await boom.svc.check('c')).lastCheckOk).toBe(false);
  });

  it('kills its child and is not ok when the timeout passes', async () => {
    const h = make({ spawnReply: () => 'hang', checkTimeoutMs: 30 });
    h.svc.create({ name: 'Acme' });
    const a = await h.svc.putToken('acme', TOKEN);
    expect(a.lastCheckOk).toBe(false);
    expect(h.sp.children[0].kill).toHaveBeenCalled();
  });

  it('shares one run between concurrent calls for the same profile', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    h.sp.calls.length = 0;
    const [x, y] = await Promise.all([h.svc.check('acme'), h.svc.check('acme')]);
    expect(h.sp.calls).toHaveLength(1);
    expect(x.lastCheckOk).toBe(true);
    expect(y.lastCheckOk).toBe(true);
  });

  it('refuses without a token (ACCOUNT_NO_TOKEN), for terminal (BUILTIN) and unknown ids', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    expect(await codeOfRejected(h.svc.check('acme'))).toBe('ACCOUNT_NO_TOKEN');
    expect(await codeOfRejected(h.svc.check('terminal'))).toBe('BUILTIN');
    expect(await codeOfRejected(h.svc.check('ghost'))).toBe('NOT_FOUND');
    expect(h.sp.calls).toHaveLength(0);
  });
});

describe('tokenFor', () => {
  it('returns null for terminal', () => {
    const { svc } = make();
    expect(svc.tokenFor('terminal')).toBeNull();
  });

  it('throws srv.account.noToken for a row without a token', () => {
    const { svc } = make();
    svc.create({ name: 'Acme' });
    let thrown: unknown;
    try {
      svc.tokenFor('acme');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandError);
    expect((thrown as { srvCode?: string }).srvCode).toBe('srv.account.noToken');
  });

  it('throws srv.account.noToken when the row has a fingerprint but the token is not loaded', async () => {
    const first = make();
    first.svc.create({ name: 'Acme' });
    await first.svc.putToken('acme', TOKEN);
    // a fresh service on the same db: no token in memory, and the secret read gives nothing
    secretStore.clear();
    const second = make();
    await second.svc.init();
    expect(() => second.svc.tokenFor('acme')).toThrow(CommandError);
    expect(() => second.svc.tokenFor('acme')).toThrow(expect.objectContaining({ srvCode: 'srv.account.noToken' }));
  });

  it('returns the token once it is loaded', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    expect(h.svc.tokenFor('acme')).toBe(TOKEN);
  });
});

describe('init', () => {
  it('loads the token of every row that has a fingerprint, skips a failed read, and never throws', async () => {
    const first = make();
    first.svc.create({ name: 'Acme' });
    first.svc.create({ name: 'Broken' });
    first.svc.create({ name: 'Plain' });
    await first.svc.putToken('acme', TOKEN);
    await first.svc.putToken('broken', TOKEN2);
    secrets.get.mockImplementation(async (k: string) => {
      if (k === 'account:broken') throw new Error('read failed');
      return secretStore.get(k) ?? null;
    });
    const second = make();
    await expect(second.svc.init()).resolves.toBeUndefined();
    expect(second.svc.tokenFor('acme')).toBe(TOKEN);
    expect(() => second.svc.tokenFor('broken')).toThrow(expect.objectContaining({ srvCode: 'srv.account.noToken' }));
    expect(secrets.get).not.toHaveBeenCalledWith('account:plain');
  });

  it('reads the default id from the setting and falls back when that account is gone', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.setDefault('acme');
    const again = make();
    await again.svc.init();
    expect(again.svc.defaultId()).toBe('acme');
    db.deleteAccount('acme');
    expect(again.svc.defaultId()).toBe('terminal');
  });
});

// ---- connect (setup-token capture) ----

const CAPTURE_URL = 'https://claude.ai/oauth/authorize?code=true&state=abc';

describe('connect', () => {
  it('throws PTY_UNAVAILABLE when no pty factory is available', () => {
    const h = make({ noPty: true });
    h.svc.create({ name: 'Acme' });
    expect(codeOfThrown(() => h.svc.connect('acme'))).toBe('PTY_UNAVAILABLE');
    expect(h.ptyFactoryCalls()).toBe(0);
  });

  it('refuses the Terminal profile and unknown ids', () => {
    const h = make();
    expect(codeOfThrown(() => h.svc.connect('terminal'))).toBe('BUILTIN');
    expect(codeOfThrown(() => h.svc.connect('ghost'))).toBe('NOT_FOUND');
  });

  it('runs the capture: waiting_browser with the url, captured, checking, then done with checkOk; the token is saved', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.connect('acme');
    h.screen.text = ['Opening browser to sign in', CAPTURE_URL];
    h.pty.push('x');
    await waitFor(() => h.connects.some((e) => e.status === 'waiting_browser'));
    expect(h.connects.find((e) => e.status === 'waiting_browser')).toEqual({ accountId: 'acme', status: 'waiting_browser', url: CAPTURE_URL });

    h.screen.text = ['Login successful', `Your token: ${TOKEN}`];
    h.pty.push('y');
    await waitFor(() => h.connects.some((e) => e.status === 'done'));
    expect(h.pty.kill).toHaveBeenCalled();
    expect(h.connects.map((e) => e.status)).toEqual(['waiting_browser', 'captured', 'checking', 'done']);
    expect(h.connects.at(-1)).toEqual({ accountId: 'acme', status: 'done', checkOk: true });
    expect(secrets.set).toHaveBeenCalledWith('account:acme', TOKEN);
    expect(h.svc.view().accounts[1]).toMatchObject({ tokenState: 'set', fingerprint: TOKEN_FP, lastCheckOk: true });
    expect(h.sp.calls[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(h.sp.calls[0].args).toEqual(CHECK_ARGS_EXPECTED);
  });

  it('reports done with checkOk false when the check fails, and the pty env drops the API keys', async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-not-for-pty';
    try {
      const h = make({ spawnReply: () => ({ code: 1, out: '' }) });
      h.svc.create({ name: 'Acme' });
      h.svc.connect('acme');
      h.screen.text = [TOKEN];
      h.pty.push('z');
      await waitFor(() => h.connects.some((e) => e.status === 'done'));
      expect(h.connects.at(-1)).toEqual({ accountId: 'acme', status: 'done', checkOk: false });
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it('answers CONNECT_BUSY while a capture runs, and cancelConnect kills the exact pid and reports cancelled', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.connect('acme');
    expect(codeOfThrown(() => h.svc.connect('acme'))).toBe('CONNECT_BUSY');
    expect(h.svc.cancelConnect()).toBe(true);
    expect(h.pty.kill).toHaveBeenCalled();
    await waitFor(() => h.connects.some((e) => e.status === 'cancelled'));
    expect(h.connects.at(-1)).toEqual({ accountId: 'acme', status: 'cancelled' });
    expect(h.svc.cancelConnect()).toBe(false);
    // the busy flag is cleared: a new capture can start
    expect(() => h.svc.connect('acme')).not.toThrow();
    expect(h.svc.cancelConnect()).toBe(true);
  });

  it('maps a pty that never finishes to timeout', async () => {
    const h = make({ connectTimeoutMs: 40 });
    h.svc.create({ name: 'Acme' });
    h.svc.connect('acme');
    await waitFor(() => h.connects.some((e) => e.status === 'timeout'));
    expect(h.connects.at(-1)).toEqual({ accountId: 'acme', status: 'timeout' });
    expect(() => h.svc.connect('acme')).not.toThrow();
    h.svc.cancelConnect();
  });

  it('maps a pty that exits without a token to failed with CONNECT_FAILED', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.connect('acme');
    h.pty.exit(1);
    await waitFor(() => h.connects.some((e) => e.status === 'failed'), 3000);
    expect(h.connects.at(-1)).toEqual({ accountId: 'acme', status: 'failed', error: 'CONNECT_FAILED' });
  });

  it('maps a captured string that is not a valid token to failed TOKEN_INVALID', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.connect('acme');
    h.screen.text = ['sk-ant-oat01-tooshort'];
    h.pty.push('p');
    await waitFor(() => h.connects.some((e) => e.status === 'failed'));
    expect(h.connects.at(-1)).toEqual({ accountId: 'acme', status: 'failed', error: 'TOKEN_INVALID' });
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it('maps a secret store failure during capture to failed SECRETS_UNAVAILABLE and frees the busy flag', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    secrets.set.mockRejectedValueOnce(new Error('vault locked'));
    h.svc.connect('acme');
    h.screen.text = [TOKEN];
    h.pty.push('q');
    await waitFor(() => h.connects.some((e) => e.status === 'failed'));
    expect(h.connects.at(-1)).toEqual({ accountId: 'acme', status: 'failed', error: 'SECRETS_UNAVAILABLE' });
    expect(() => h.svc.connect('acme')).not.toThrow();
    h.svc.cancelConnect();
  });
});

// ---- usage ----

describe('recordUsage', () => {
  it('merges the two windows of a rate_limit_event into the row, as percentages and reset times', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.recordUsage('acme', RATE_EVENT);
    const u = h.svc.view().accounts[1].usage;
    expect(u).not.toBeNull();
    expect(u?.fiveHour?.pct).toBeCloseTo(67, 5);
    expect(u?.sevenDay?.pct).toBeCloseTo(7, 5);
    expect(u?.fiveHour?.resetsAt).toBe(1795408200 * 1000);
    expect(u?.updatedAt).toBe(clock);
  });

  it('keeps the other window when an event carries only one', () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.recordUsage('acme', RATE_EVENT);
    clock += 10_000;
    h.svc.recordUsage('acme', {
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 1795408200 } } },
    });
    const u = h.svc.view().accounts[1].usage;
    expect(u?.fiveHour?.pct).toBeCloseTo(90, 5);
    expect(u?.sevenDay?.pct).toBeCloseTo(7, 5);
  });

  it('ignores other stream events and unknown accounts without throwing', () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.recordUsage('acme', { type: 'assistant' });
    h.svc.recordUsage('ghost', RATE_EVENT);
    h.svc.recordUsage('acme', null);
    expect(h.svc.view().accounts[1].usage).toBeNull();
  });

  it('persists always but emits change at most once per 2 s per account', () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    const before = h.changes.length;
    h.svc.recordUsage('acme', RATE_EVENT);
    h.svc.recordUsage('acme', RATE_EVENT);
    h.svc.recordUsage('acme', RATE_EVENT);
    expect(h.changes.length - before).toBe(1);
    // still persisted on every call
    expect(db.getAccount('acme')?.lastUsage?.fiveHour?.pct).toBeCloseTo(67, 5);
  });

  it('stores the terminal profile usage in its setting so it survives a restart', () => {
    const h = make();
    h.svc.recordUsage('terminal', RATE_EVENT);
    expect(h.svc.view().accounts[0].usage?.sevenDay?.pct).toBeCloseTo(7, 5);
    const again = make();
    expect(again.svc.view().accounts[0].usage?.fiveHour?.pct).toBeCloseTo(67, 5);
  });
});

// ---- sessions ----

describe('sessions', () => {
  it('remembers the profile of a session and prunes old pins on init', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.rememberSession('s1', 'acme');
    expect(h.svc.sessionAccount('s1')).toBe('acme');
    expect(h.svc.sessionAccount('none')).toBeNull();
    clock += 91 * 24 * 3600_000;
    await h.svc.init();
    expect(h.svc.sessionAccount('s1')).toBeNull();
  });
});

// ---- the leak test: a token value appears only in the child env and the secret store ----

describe('token leak', () => {
  it('the fake token never shows up in the view, the events, the logs, the spawn argv, the db or any thrown message', async () => {
    const h = make({ spawnReply: () => ({ code: 0, out: JSON.stringify({ is_error: false, result: TOKEN }) }) });
    const errors: string[] = [];
    const collect = async (fn: () => unknown | Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        errors.push(String((e as Error).message ?? e), String((e as Error).stack ?? ''));
      }
    };

    h.svc.create({ name: 'Acme' });
    h.svc.create({ name: 'Second' });
    await collect(() => h.svc.putToken('acme', TOKEN));
    await collect(() => h.svc.putToken('acme', TOKEN + '!'));
    await collect(() => h.svc.putToken('ghost', TOKEN));
    await collect(() => h.svc.putToken('terminal', TOKEN));
    await collect(() => h.svc.check('second'));
    await collect(() => h.svc.patch('acme', { note: 'n' }));
    await collect(() => h.svc.patch('terminal', { name: 'x' }));
    h.svc.recordUsage('acme', RATE_EVENT);

    h.svc.connect('second');
    h.screen.text = ['Opening browser', CAPTURE_URL];
    h.pty.push('a');
    await waitFor(() => h.connects.some((e) => e.status === 'waiting_browser'));
    h.screen.text = [TOKEN];
    h.pty.push('b');
    await waitFor(() => h.connects.some((e) => e.status === 'done'));

    const view = JSON.stringify(h.svc.view());
    const events = JSON.stringify([h.connects, h.changes]);
    const logText = JSON.stringify(logs);
    const argv = JSON.stringify(h.sp.calls.map((c) => c.args));
    const rows = JSON.stringify(db.listAccounts());
    const errText = JSON.stringify(errors);
    for (const [name, text] of [
      ['view', view],
      ['events', events],
      ['logs', logText],
      ['argv', argv],
      ['db', rows],
      ['errors', errText],
    ] as const) {
      expect(text, name).not.toContain(TOKEN);
      expect(text, name).not.toContain('LeakTest0123');
    }
    // the token did go where it should: the secret store and the child env
    expect(secretStore.get('account:second')).toBe(TOKEN);
    expect(h.sp.calls.some((c) => c.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---- stream-json health check, usage from the check, refreshUsage ----

const STREAM_OK = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify(RATE_EVENT),
  JSON.stringify({ type: 'result', is_error: false, result: 'ok' }),
].join('\n') + '\n';

describe('check with stream-json', () => {
  it('is ok on a result line without is_error, and records the rate_limit_event it printed', async () => {
    const h = make({ spawnReply: () => ({ code: 0, out: STREAM_OK }) });
    h.svc.create({ name: 'Acme' });
    const a = await h.svc.putToken('acme', TOKEN);
    expect(a.lastCheckOk).toBe(true);
    expect(a.usage?.fiveHour?.pct).toBeCloseTo(67, 5);
    expect(a.usage?.sevenDay?.pct).toBeCloseTo(7, 5);
    expect(a.usage?.updatedAt).toBe(clock);
    expect(h.sp.calls[0].args).toEqual(CHECK_ARGS_EXPECTED);
  });

  it('is not ok when the result line reports is_error true, even with a rate event before it', async () => {
    const out = [JSON.stringify(RATE_EVENT), JSON.stringify({ type: 'result', is_error: true, result: 'x' })].join('\n');
    const h = make({ spawnReply: () => ({ code: 0, out }) });
    h.svc.create({ name: 'Acme' });
    const a = await h.svc.putToken('acme', TOKEN);
    expect(a.lastCheckOk).toBe(false);
    expect(a.usage?.sevenDay?.pct).toBeCloseTo(7, 5);
  });

  it('is not ok for stream-json output with no result line', async () => {
    const h = make({ spawnReply: () => ({ code: 0, out: JSON.stringify(RATE_EVENT) + '\n' }) });
    h.svc.create({ name: 'Acme' });
    expect((await h.svc.putToken('acme', TOKEN)).lastCheckOk).toBe(false);
  });

  it('still accepts the legacy single JSON object', async () => {
    const h = make({ spawnReply: () => ({ code: 0, out: JSON.stringify({ is_error: false, result: 'ok' }, null, 2) }) });
    h.svc.create({ name: 'Acme' });
    expect((await h.svc.putToken('acme', TOKEN)).lastCheckOk).toBe(true);
  });

  it('a non-zero exit is not ok, though the rate event it printed is still recorded', async () => {
    const h = make({ spawnReply: () => ({ code: 1, out: STREAM_OK }) });
    h.svc.create({ name: 'Acme' });
    const a = await h.svc.putToken('acme', TOKEN);
    expect(a.lastCheckOk).toBe(false);
    expect(a.usage?.fiveHour?.pct).toBeCloseTo(67, 5);
  });
});

describe('refreshUsage', () => {
  it('returns the stored usage without spawning when it is younger than 10 min', async () => {
    const h = make({ spawnReply: () => ({ code: 0, out: STREAM_OK }) });
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    h.sp.calls.length = 0;
    clock += 9 * 60_000;
    const a = await h.svc.refreshUsage('acme');
    expect(h.sp.calls).toHaveLength(0);
    expect(a.usage?.sevenDay?.pct).toBeCloseTo(7, 5);
  });

  it('runs one check when the stored usage is 10 min old or more, and returns the new info', async () => {
    const h = make({ spawnReply: () => ({ code: 0, out: STREAM_OK }) });
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    h.sp.calls.length = 0;
    clock += 10 * 60_000;
    const a = await h.svc.refreshUsage('acme');
    expect(h.sp.calls).toHaveLength(1);
    expect(a.lastCheckAt).toBe(clock);
    expect(a.lastCheckOk).toBe(true);
  });

  it('runs one check when the profile has never recorded usage', async () => {
    const h = make({ spawnReply: () => ({ code: 0, out: OK_OUT }) });
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    h.sp.calls.length = 0;
    await h.svc.refreshUsage('acme');
    expect(h.sp.calls).toHaveLength(1);
  });

  it('shares one spawn between concurrent calls', async () => {
    const h = make({ spawnReply: () => ({ code: 0, out: STREAM_OK }) });
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    h.sp.calls.length = 0;
    clock += 11 * 60_000;
    const [x, y] = await Promise.all([h.svc.refreshUsage('acme'), h.svc.refreshUsage('acme')]);
    expect(h.sp.calls).toHaveLength(1);
    expect(x.lastCheckOk).toBe(true);
    expect(y.lastCheckOk).toBe(true);
  });

  it('refuses the Terminal profile (BUILTIN), unknown ids (NOT_FOUND) and a profile without a token (ACCOUNT_NO_TOKEN)', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    expect(await codeOfRejected(h.svc.refreshUsage('terminal'))).toBe('BUILTIN');
    expect(await codeOfRejected(h.svc.refreshUsage('ghost'))).toBe('NOT_FOUND');
    expect(await codeOfRejected(h.svc.refreshUsage('acme'))).toBe('ACCOUNT_NO_TOKEN');
    expect(h.sp.calls).toHaveLength(0);
  });
});

describe('dispose', () => {
  it('clears a pending usage emit, so no change fires after dispose and a later recordUsage does nothing', () => {
    vi.useFakeTimers();
    try {
      const h = make();
      h.svc.create({ name: 'Acme' });
      h.svc.recordUsage('acme', RATE_EVENT); // emits at once
      h.svc.recordUsage('acme', RATE_EVENT); // within 2 s: a trailing emit is queued
      const before = h.changes.length;
      h.svc.dispose();
      vi.advanceTimersByTime(10_000);
      expect(h.changes.length).toBe(before);
      h.svc.recordUsage('acme', RATE_EVENT);
      vi.advanceTimersByTime(10_000);
      expect(h.changes.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is idempotent and stops a running connect', () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    h.svc.connect('acme');
    h.svc.dispose();
    expect(h.pty.kill).toHaveBeenCalled();
    expect(() => h.svc.dispose()).not.toThrow();
  });

  it('kills a `claude -p` check in flight and settles it as failed without emitting', async () => {
    const h = make({ spawnReply: () => 'hang' });
    h.svc.create({ name: 'Acme' });
    const pending = h.svc.putToken('acme', TOKEN);
    await waitFor(() => h.sp.children.length > 0);
    const emitted = h.changes.length;
    h.svc.dispose();
    expect(h.sp.children[0].kill).toHaveBeenCalled();
    const a = await pending;
    expect(a.lastCheckOk).toBe(false);
    expect(h.changes.length).toBe(emitted);
  });

  it('exposes the main account status on the Terminal row only while it is known', () => {
    let info: MainAccountInfo | null = null;
    const h = make({ main: { info: () => info } });
    expect(h.svc.view().accounts[0]).not.toHaveProperty('main');
    info = { loggedIn: true, email: 'a***@example.com', plan: 'max', orgName: null, expiresAt: null, checkedAt: clock };
    expect(h.svc.view().accounts[0].main).toEqual(info);
  });
});

// ---- profile passwords (envelope in the secret store, unlock, lockout, set/change/remove) ----

describe('profile passwords', () => {
  const PASSWORD = 'pw-test-1234';
  const NEW_PASSWORD = 'pw-new-5678';
  const WRONG = 'wrong-pass';
  const ENV_KEY = 'account:acme';

  /** Profile 'acme' with TOKEN, protected by PASSWORD in the secret store; returns a fresh service that has locked it. */
  async function lockedAcme(): Promise<Harness> {
    const first = make({ scryptN: 1024 });
    first.svc.create({ name: 'Acme' });
    await first.svc.putToken('acme', TOKEN);
    await first.svc.setPassword('acme', { next: PASSWORD });
    const second = make({ scryptN: 1024 });
    await second.svc.init();
    return second;
  }

  function tokenMap(svc: AccountService): Map<string, string> {
    return (svc as unknown as { tokens: Map<string, string> }).tokens;
  }

  it('init with an enveloped entry locks the profile and keeps the token out of memory', async () => {
    const h = await lockedAcme();
    expect(isEnvelopeText(secretStore.get(ENV_KEY) ?? '')).toBe(true);
    expect(h.svc.isLocked('acme')).toBe(true);
    expect(tokenMap(h.svc).has('acme')).toBe(false);
    expect(codeOfThrown(() => h.svc.tokenFor('acme'))).toBe('srv.account.locked');
    expect(() => h.svc.tokenFor('acme')).toThrow(CommandError);
    const acme = h.svc.view().accounts.find((a) => a.id === 'acme');
    expect(acme).toMatchObject({ locked: true, hasPassword: true });
  });

  it('nothing service-visible ever carries the token or the password', async () => {
    const h = await lockedAcme();
    await h.svc.unlock('acme', WRONG).catch(() => undefined);
    await h.svc.unlock('acme', PASSWORD);
    const visible = JSON.stringify([h.svc.view(), logs, h.changes, h.connects]);
    expect(visible).not.toContain(TOKEN);
    expect(visible).not.toContain(PASSWORD);
    expect(visible).not.toContain(WRONG);
  });

  it('unlock: wrong password is BAD_PASSWORD, right one loads the token and emits unlocked', async () => {
    const h = await lockedAcme();
    const unlocked = vi.fn();
    h.svc.on('unlocked', unlocked);
    expect(await codeOfRejected(h.svc.unlock('acme', WRONG))).toBe('BAD_PASSWORD');
    expect(unlocked).not.toHaveBeenCalled();
    const info = await h.svc.unlock('acme', PASSWORD);
    expect(info).toMatchObject({ id: 'acme', locked: false, hasPassword: true });
    expect(unlocked).toHaveBeenCalledWith('acme');
    expect(h.changes.at(-1)?.accounts.find((a) => a.id === 'acme')?.locked).toBe(false);
    expect(h.svc.tokenFor('acme')).toBe(TOKEN);
  });

  it('unlock of a profile without a password is NO_PASSWORD; unknown profile is NOT_FOUND', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    expect(await codeOfRejected(h.svc.unlock('acme', PASSWORD))).toBe('NO_PASSWORD');
    expect(await codeOfRejected(h.svc.unlock('ghost', PASSWORD))).toBe('NOT_FOUND');
  });

  it('5 wrong tries lock the profile for 30 s, then the right password works again', async () => {
    const h = await lockedAcme();
    for (let i = 0; i < 5; i++) expect(await codeOfRejected(h.svc.unlock('acme', WRONG))).toBe('BAD_PASSWORD');
    expect(await codeOfRejected(h.svc.unlock('acme', PASSWORD))).toBe('TOO_MANY_TRIES');
    clock += 29_000;
    expect(await codeOfRejected(h.svc.unlock('acme', PASSWORD))).toBe('TOO_MANY_TRIES');
    clock += 1_000;
    await expect(h.svc.unlock('acme', PASSWORD)).resolves.toMatchObject({ locked: false });
  });

  it('a successful try resets the wrong-try counter', async () => {
    const h = await lockedAcme();
    for (let i = 0; i < 4; i++) expect(await codeOfRejected(h.svc.unlock('acme', WRONG))).toBe('BAD_PASSWORD');
    await h.svc.unlock('acme', PASSWORD);
    // unlocked now: a change needs the current password; 4 more wrong ones must not lock (counter was reset)
    for (let i = 0; i < 4; i++) {
      expect(await codeOfRejected(h.svc.setPassword('acme', { current: WRONG, next: NEW_PASSWORD }))).toBe('BAD_PASSWORD');
    }
    await expect(h.svc.setPassword('acme', { current: PASSWORD, next: NEW_PASSWORD })).resolves.toMatchObject({ hasPassword: true });
  });

  it('check and refreshUsage on a locked profile spawn nothing', async () => {
    const h = await lockedAcme();
    const before = h.sp.calls.length;
    await expect(h.svc.check('acme')).resolves.toMatchObject({ id: 'acme', locked: true });
    await expect(h.svc.refreshUsage('acme')).resolves.toMatchObject({ id: 'acme', locked: true });
    expect(h.sp.calls.length).toBe(before);
  });

  it('set: stores an envelope (not the token), stays unlocked this run, and rejects a bad password', async () => {
    const h = make({ scryptN: 1024 });
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    expect(await codeOfRejected(h.svc.setPassword('acme', { next: 'abc' }))).toBe('PASSWORD_INVALID');
    const info = await h.svc.setPassword('acme', { next: PASSWORD });
    expect(info).toMatchObject({ locked: false, hasPassword: true });
    expect(isEnvelopeText(secretStore.get(ENV_KEY) ?? '')).toBe(true);
    expect(secretStore.get(ENV_KEY)).not.toContain(TOKEN);
    expect(h.svc.tokenFor('acme')).toBe(TOKEN);
  });

  it('set: no token loaded is ACCOUNT_NO_TOKEN; neither current nor next is BAD_REQUEST', async () => {
    const h = make({ scryptN: 1024 });
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    expect(await codeOfRejected(h.svc.setPassword('acme', {}))).toBe('BAD_REQUEST');
    secretStore.clear();
    const again = make({ scryptN: 1024 });
    await again.svc.init();
    expect(await codeOfRejected(again.svc.setPassword('acme', { next: PASSWORD }))).toBe('ACCOUNT_NO_TOKEN');
  });

  it('set: a refused secret write changes nothing in memory', async () => {
    const h = make({ scryptN: 1024 });
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    secrets.set.mockRejectedValueOnce(new Error('store down'));
    expect(await codeOfRejected(h.svc.setPassword('acme', { next: PASSWORD }))).toBe('SECRETS_UNAVAILABLE');
    expect(h.svc.view().accounts.find((a) => a.id === 'acme')).toMatchObject({ hasPassword: false, locked: false });
    expect(h.svc.tokenFor('acme')).toBe(TOKEN);
  });

  it('set while passworded: no current is PROFILE_LOCKED when locked and BAD_PASSWORD when unlocked', async () => {
    const h = await lockedAcme();
    expect(await codeOfRejected(h.svc.setPassword('acme', { next: NEW_PASSWORD }))).toBe('PROFILE_LOCKED');
    await h.svc.unlock('acme', PASSWORD);
    expect(await codeOfRejected(h.svc.setPassword('acme', { next: NEW_PASSWORD }))).toBe('BAD_PASSWORD');
  });

  it('change: wrong current is BAD_PASSWORD; right current replaces the envelope', async () => {
    const h = await lockedAcme();
    expect(await codeOfRejected(h.svc.setPassword('acme', { current: WRONG, next: NEW_PASSWORD }))).toBe('BAD_PASSWORD');
    const old = secretStore.get(ENV_KEY);
    await expect(h.svc.setPassword('acme', { current: PASSWORD, next: NEW_PASSWORD })).resolves.toMatchObject({ hasPassword: true });
    expect(secretStore.get(ENV_KEY)).not.toBe(old);
    const again = make({ scryptN: 1024 });
    await again.svc.init();
    expect(await codeOfRejected(again.svc.unlock('acme', PASSWORD))).toBe('BAD_PASSWORD');
    await expect(again.svc.unlock('acme', NEW_PASSWORD)).resolves.toMatchObject({ locked: false });
  });

  it('remove: right current stores the raw token again and drops the password', async () => {
    const h = await lockedAcme();
    expect(await codeOfRejected(h.svc.setPassword('acme', { current: WRONG }))).toBe('BAD_PASSWORD');
    await expect(h.svc.setPassword('acme', { current: PASSWORD })).resolves.toMatchObject({ hasPassword: false, locked: false });
    expect(secretStore.get(ENV_KEY)).toBe(TOKEN);
    expect(h.svc.tokenFor('acme')).toBe(TOKEN);
  });

  it('remove on a profile without a password is NO_PASSWORD', async () => {
    const h = make();
    h.svc.create({ name: 'Acme' });
    await h.svc.putToken('acme', TOKEN);
    expect(await codeOfRejected(h.svc.setPassword('acme', { current: PASSWORD }))).toBe('NO_PASSWORD');
  });

  it('terminal is BUILTIN and an unknown profile is NOT_FOUND', async () => {
    const h = make();
    expect(await codeOfRejected(h.svc.setPassword('terminal', { next: PASSWORD }))).toBe('BUILTIN');
    expect(await codeOfRejected(h.svc.setPassword('ghost', { next: PASSWORD }))).toBe('NOT_FOUND');
  });

  it('putToken on a passworded profile stores the new raw token and drops the password', async () => {
    const h = await lockedAcme();
    await h.svc.putToken('acme', TOKEN2);
    expect(secretStore.get(ENV_KEY)).toBe(TOKEN2);
    expect(h.svc.view().accounts.find((a) => a.id === 'acme')).toMatchObject({ locked: false, hasPassword: false });
    expect(h.svc.tokenFor('acme')).toBe(TOKEN2);
  });

  it('remove of a locked profile drops its lock state', async () => {
    const h = await lockedAcme();
    await h.svc.remove('acme');
    expect(h.svc.isLocked('acme')).toBe(false);
    expect(h.svc.exists('acme')).toBe(false);
  });
});

/** True when the text has the shape of a password envelope (no secret content check). */
function isEnvelopeText(s: string): boolean {
  return s.startsWith('{') && s.includes('"kdf":"scrypt"');
}
