import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_LOCK_CLOSE_CODE, formatWait, getAuthState, isAppLockClose, readStdinLine, readTtyPassword, sessionCookieOf, unlockIfRequired } from '../src/auth.ts';
import type { AuthIo, TtyInput } from '../src/auth.ts';
import { parseArgs, USAGE } from '../src/args.ts';

// Fake PINs only. Never a real credential.
const PIN = '482913';
const WRONG = '135790';
const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const BASE = 'http://127.0.0.1:8790';

interface FakeServer {
  fetch: typeof fetch;
  unlockBodies: string[];
  stateCalls: number;
}

/**
 * A fake Control Room HTTP side. `unlockReplies` is consumed in order; the last one repeats.
 * 'wait' is a 429 with retryAfterMs 754000 (12:34).
 */
function fakeServer(opts: { state: 'locked' | 'open' | 'old' | 'hang' | 'throw'; unlockReplies?: Array<'ok' | 'bad' | 'wait'> }): FakeServer {
  const replies = [...(opts.unlockReplies ?? ['ok'])];
  const srv: FakeServer = { fetch: undefined as unknown as typeof fetch, unlockBodies: [], stateCalls: 0 };
  srv.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/auth/state') {
      srv.stateCalls++;
      if (opts.state === 'throw') throw new Error('ECONNREFUSED');
      if (opts.state === 'hang') return new Promise<Response>(() => {});
      if (opts.state === 'old') return new Response('not found', { status: 404 });
      return Response.json({ required: opts.state === 'locked', unlocked: opts.state === 'open' });
    }
    if (path === '/api/auth/unlock') {
      srv.unlockBodies.push(String(init?.body ?? ''));
      const r = replies.length > 1 ? replies.shift()! : replies[0];
      if (r === 'ok') {
        return new Response(JSON.stringify({ ok: true, required: true, unlocked: true }), {
          status: 200,
          headers: { 'Set-Cookie': `cr_session=${SID}; HttpOnly; SameSite=Strict; Path=/` },
        });
      }
      if (r === 'wait') return Response.json({ ok: false, error: 'TOO_MANY_TRIES', retryAfterMs: 754_000 }, { status: 429 });
      return Response.json({ ok: false, error: 'BAD_PASSWORD' }, { status: 401 });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return srv;
}

function makeIo(srv: FakeServer, o: { tty?: Array<string | null>; stdinLine?: string; stdinIsTTY?: boolean } = {}) {
  const ttyAnswers = [...(o.tty ?? [])];
  const io = {
    fetch: srv.fetch,
    stdinIsTTY: o.stdinIsTTY ?? true,
    readStdinLine: vi.fn(async () => o.stdinLine ?? ''),
    readTtyPassword: vi.fn(async (_prompt: string) => (ttyAnswers.length ? ttyAnswers.shift()! : null)),
  };
  return io satisfies AuthIo & { readStdinLine: unknown; readTtyPassword: unknown };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getAuthState', () => {
  it('reads required/unlocked from the server', async () => {
    expect(await getAuthState(BASE, fakeServer({ state: 'locked' }).fetch)).toEqual({ required: true, unlocked: false });
    expect(await getAuthState(BASE, fakeServer({ state: 'open' }).fetch)).toEqual({ required: false, unlocked: true });
  });

  it('treats an old server (404), a refused connection, and a hang as not required', async () => {
    expect(await getAuthState(BASE, fakeServer({ state: 'old' }).fetch)).toMatchObject({ required: false });
    expect(await getAuthState(BASE, fakeServer({ state: 'throw' }).fetch)).toMatchObject({ required: false });
    expect(await getAuthState(BASE, fakeServer({ state: 'hang' }).fetch, 20)).toMatchObject({ required: false });
  });
});

describe('unlockIfRequired', () => {
  it('not required: no prompt, no unlock call, no cookie', async () => {
    const srv = fakeServer({ state: 'open' });
    const io = makeIo(srv, { tty: [PIN] });
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify: vi.fn() });
    expect(r).toEqual({ ok: true });
    expect(io.readTtyPassword).not.toHaveBeenCalled();
    expect(io.readStdinLine).not.toHaveBeenCalled();
    expect(srv.unlockBodies).toEqual([]);
  });

  it('old server (404): no prompt and no cookie', async () => {
    const srv = fakeServer({ state: 'old' });
    const io = makeIo(srv, { tty: [PIN] });
    expect(await unlockIfRequired({ base: BASE, pinStdin: false, io, notify: vi.fn() })).toEqual({ ok: true });
    expect(io.readTtyPassword).not.toHaveBeenCalled();
  });

  it('required on a TTY: prompts "PIN: " once, unlocks once, returns the session cookie', async () => {
    const srv = fakeServer({ state: 'locked', unlockReplies: ['ok'] });
    const io = makeIo(srv, { tty: [PIN] });
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify: vi.fn() });
    expect(r).toEqual({ ok: true, cookie: `cr_session=${SID}` });
    expect(io.readTtyPassword).toHaveBeenCalledTimes(1);
    expect(io.readTtyPassword).toHaveBeenCalledWith('PIN: ');
    expect(srv.unlockBodies).toHaveLength(1);
    expect(JSON.parse(srv.unlockBodies[0])).toEqual({ password: PIN });
  });

  it('wrong then right: second prompt succeeds and the user is told how many tries are left', async () => {
    const srv = fakeServer({ state: 'locked', unlockReplies: ['bad', 'ok'] });
    const io = makeIo(srv, { tty: [WRONG, PIN] });
    const notify = vi.fn();
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify });
    expect(r).toEqual({ ok: true, cookie: `cr_session=${SID}` });
    expect(io.readTtyPassword).toHaveBeenCalledTimes(2);
    expect(srv.unlockBodies).toHaveLength(2);
    expect(notify).toHaveBeenCalledWith('PIN ไม่ถูกต้อง (เหลือ 2 ครั้ง)');
  });

  it('three wrong PINs: exit with a Thai error after 3 server tries', async () => {
    const srv = fakeServer({ state: 'locked', unlockReplies: ['bad'] });
    const io = makeIo(srv, { tty: [WRONG, '246813', '112233', PIN] });
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify: vi.fn() });
    expect(r).toEqual({ ok: false, error: 'PIN ไม่ถูกต้อง (ลองครบ 3 ครั้งแล้ว)' });
    expect(io.readTtyPassword).toHaveBeenCalledTimes(3);
    expect(srv.unlockBodies).toHaveLength(3);
  });

  it('429 TOO_MANY_TRIES: stops at once and prints the wait as m:ss from retryAfterMs', async () => {
    const srv = fakeServer({ state: 'locked', unlockReplies: ['wait'] });
    const io = makeIo(srv, { tty: [PIN, PIN] });
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify: vi.fn() });
    expect(r).toEqual({ ok: false, error: 'ใส่ PIN ผิดหลายครั้งเกินไป — ลองใหม่ได้ใน 12:34' });
    expect(io.readTtyPassword).toHaveBeenCalledTimes(1);
  });

  it('429 without a usable body: a generic retry text, still no second try', async () => {
    const f = (async () => new Response('busy', { status: 429 })) as unknown as typeof fetch;
    const state = (async () => Response.json({ required: true, unlocked: false })) as unknown as typeof fetch;
    const io = makeIo(fakeServer({ state: 'locked' }), { tty: [PIN, PIN] });
    const fetchBoth = (async (url: string, init?: RequestInit) => (String(url).endsWith('/state') ? state(url) : f(url, init))) as typeof fetch;
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io: { ...io, fetch: fetchBoth }, notify: vi.fn() });
    expect(r).toEqual({ ok: false, error: 'ใส่ PIN ผิดหลายครั้งเกินไป — ลองใหม่ทีหลัง' });
    expect(io.readTtyPassword).toHaveBeenCalledTimes(1);
  });

  it('not a TTY and no --pin-stdin: Thai error, nothing is sent', async () => {
    const srv = fakeServer({ state: 'locked' });
    const io = makeIo(srv, { tty: [PIN], stdinIsTTY: false });
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify: vi.fn() });
    expect(r.ok).toBe(false);
    expect(io.readTtyPassword).not.toHaveBeenCalled();
    expect(srv.unlockBodies).toEqual([]);
  });

  it('--pin-stdin: reads the first line of stdin, unlocks, no TTY needed', async () => {
    const srv = fakeServer({ state: 'locked', unlockReplies: ['ok'] });
    const io = makeIo(srv, { stdinLine: PIN, stdinIsTTY: false });
    const r = await unlockIfRequired({ base: BASE, pinStdin: true, io, notify: vi.fn() });
    expect(r).toEqual({ ok: true, cookie: `cr_session=${SID}` });
    expect(io.readStdinLine).toHaveBeenCalledTimes(1);
    expect(io.readTtyPassword).not.toHaveBeenCalled();
    expect(JSON.parse(srv.unlockBodies[0])).toEqual({ password: PIN });
  });

  it('--pin-stdin with a wrong PIN: one try only, Thai error', async () => {
    const srv = fakeServer({ state: 'locked', unlockReplies: ['bad'] });
    const io = makeIo(srv, { stdinLine: WRONG, stdinIsTTY: false });
    const r = await unlockIfRequired({ base: BASE, pinStdin: true, io, notify: vi.fn() });
    expect(r).toEqual({ ok: false, error: 'PIN ไม่ถูกต้อง' });
    expect(srv.unlockBodies).toHaveLength(1);
  });

  it('--pin-stdin with an empty stdin: Thai error, no unlock call', async () => {
    const srv = fakeServer({ state: 'locked' });
    const io = makeIo(srv, { stdinLine: '', stdinIsTTY: false });
    const r = await unlockIfRequired({ base: BASE, pinStdin: true, io, notify: vi.fn() });
    expect(r).toEqual({ ok: false, error: 'ไม่มี PIN ใน stdin' });
    expect(srv.unlockBodies).toEqual([]);
  });

  it('--pin-stdin with a malformed PIN: refused locally, the server is never contacted', async () => {
    for (const bad of ['12345', '1234567', '12345a', ' 123456']) {
      const srv = fakeServer({ state: 'locked' });
      const io = makeIo(srv, { stdinLine: bad, stdinIsTTY: false });
      const r = await unlockIfRequired({ base: BASE, pinStdin: true, io, notify: vi.fn() });
      expect(r).toEqual({ ok: false, error: 'PIN ต้องเป็นตัวเลข 6 หลัก' });
      expect(srv.unlockBodies).toEqual([]);
    }
  });

  it('malformed PINs at the prompt: re-prompted locally up to 3 times, the server only sees the valid one', async () => {
    const srv = fakeServer({ state: 'locked', unlockReplies: ['ok'] });
    const io = makeIo(srv, { tty: ['12a', '1234567', PIN] });
    const notify = vi.fn();
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify });
    expect(r).toEqual({ ok: true, cookie: `cr_session=${SID}` });
    expect(io.readTtyPassword).toHaveBeenCalledTimes(3);
    expect(srv.unlockBodies).toHaveLength(1);
    expect(notify).toHaveBeenNthCalledWith(1, 'PIN ต้องเป็นตัวเลข 6 หลัก (เหลือ 2 ครั้ง)');
    expect(notify).toHaveBeenNthCalledWith(2, 'PIN ต้องเป็นตัวเลข 6 หลัก (เหลือ 1 ครั้ง)');
  });

  it('three malformed PINs at the prompt: Thai error, the server is never contacted', async () => {
    const srv = fakeServer({ state: 'locked' });
    const io = makeIo(srv, { tty: ['a', 'b', 'c', PIN] });
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify: vi.fn() });
    expect(r).toEqual({ ok: false, error: 'PIN ต้องเป็นตัวเลข 6 หลัก (ลองครบ 3 ครั้งแล้ว)' });
    expect(io.readTtyPassword).toHaveBeenCalledTimes(3);
    expect(srv.unlockBodies).toEqual([]);
  });

  it('cancelled prompt (Ctrl-C) stops with a Thai message', async () => {
    const srv = fakeServer({ state: 'locked' });
    const io = makeIo(srv, { tty: [] });
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify: vi.fn() });
    expect(r).toEqual({ ok: false, error: 'ยกเลิกการใส่ PIN' });
    expect(srv.unlockBodies).toEqual([]);
  });

  it('the PIN never appears in any printed, notified or returned string', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    const notes: string[] = [];
    const srv = fakeServer({ state: 'locked', unlockReplies: ['bad', 'bad', 'bad'] });
    const io = makeIo(srv, { tty: ['9' + PIN, PIN.slice(1) + '1', PIN] });
    const notify = (m: string) => {
      notes.push(m);
      console.error(m);
    };
    const r = await unlockIfRequired({ base: BASE, pinStdin: false, io, notify });
    const all = [...logs, ...notes, JSON.stringify(r)];
    for (const s of all) expect(s).not.toContain(PIN);
    // the cookie is returned to the caller only, never printed here
    expect(JSON.stringify(r)).not.toContain(PIN);
  });
});

describe('formatWait', () => {
  it('prints m:ss, rounding a partial second up', () => {
    expect(formatWait(0)).toBe('0:00');
    expect(formatWait(1)).toBe('0:01');
    expect(formatWait(30_000)).toBe('0:30');
    expect(formatWait(600_000)).toBe('10:00');
    expect(formatWait(754_000)).toBe('12:34');
    expect(formatWait(1_799_999)).toBe('30:00');
  });
});

describe('--pin-stdin flag', () => {
  it('is a boolean flag: parsed, and off by default', () => {
    expect(parseArgs(['--pin-stdin', 'ls'], 'C:\\work')).toMatchObject({ ok: true, pinStdin: true, command: { kind: 'ls' } });
    expect(parseArgs(['ls'], 'C:\\work')).toMatchObject({ ok: true, pinStdin: false });
    expect(parseArgs(['--pin-stdin=yes', 'ls'], 'C:\\work')).toMatchObject({ ok: false });
  });

  it('--password-stdin is still accepted as an alias', () => {
    expect(parseArgs(['--password-stdin', 'ls'], 'C:\\work')).toMatchObject({ ok: true, pinStdin: true });
  });

  it('the usage text names --pin-stdin and no longer names the password flag', () => {
    expect(USAGE).toContain('--pin-stdin');
    expect(USAGE).toContain('PIN');
    expect(USAGE).not.toContain('--password-stdin');
    expect(USAGE).not.toContain('รหัสผ่าน');
  });
});

describe('sessionCookieOf', () => {
  it('keeps only the cr_session pair', () => {
    expect(sessionCookieOf(`cr_session=${SID}; HttpOnly; SameSite=Strict; Path=/`)).toBe(`cr_session=${SID}`);
    expect(sessionCookieOf(`other=1, cr_session=${SID}; Path=/`)).toBe(`cr_session=${SID}`);
    expect(sessionCookieOf('other=1; Path=/')).toBeUndefined();
    expect(sessionCookieOf(null)).toBeUndefined();
  });
});

describe('isAppLockClose', () => {
  it('true only for close code 4401', () => {
    expect(APP_LOCK_CLOSE_CODE).toBe(4401);
    expect(isAppLockClose(Object.assign(new Error('closed'), { code: 4401 }))).toBe(true);
    expect(isAppLockClose(Object.assign(new Error('closed'), { code: 1006 }))).toBe(false);
    expect(isAppLockClose(new Error('timeout'))).toBe(false);
  });
});

describe('readStdinLine', () => {
  it('returns the first line without its CR and ignores the rest', async () => {
    const input = Readable.from(['pw-line\r\nsecond\n']);
    expect(await readStdinLine(input as unknown as Parameters<typeof readStdinLine>[0])).toBe('pw-line');
  });

  it('returns what is there at end of input when no newline came', async () => {
    const input = Readable.from(['only']);
    expect(await readStdinLine(input as unknown as Parameters<typeof readStdinLine>[0])).toBe('only');
  });
});

/** Fake TTY: emits chunks, records raw-mode toggles. */
function fakeTty(): TtyInput & { feed: (chunk: string) => void; raw: boolean[] } {
  const ee = new EventEmitter();
  const raw: boolean[] = [];
  return Object.assign(ee, {
    raw,
    setRawMode(on: boolean) {
      raw.push(on);
    },
    setEncoding() {},
    resume() {},
    pause() {},
    feed: (chunk: string) => ee.emit('data', chunk),
  }) as unknown as TtyInput & { feed: (chunk: string) => void; raw: boolean[] };
}

describe('readTtyPassword', () => {
  it('reads typed characters with no echo; Backspace deletes; Enter ends; raw mode restored', async () => {
    const tty = fakeTty();
    const out: string[] = [];
    const p = readTtyPassword(tty, { write: (s: string) => void out.push(s) }, 'PIN: ');
    tty.feed('48');
    tty.feed('\u007f8');
    tty.feed('2913\r');
    expect(await p).toBe('482913');
    expect(out.join('')).toBe('PIN: \n');
    expect(tty.raw).toEqual([true, false]);
  });

  it('Ctrl-C cancels with null and still restores the terminal', async () => {
    const tty = fakeTty();
    const out: string[] = [];
    const p = readTtyPassword(tty, { write: (s: string) => void out.push(s) }, 'PIN: ');
    tty.feed('482\u0003');
    expect(await p).toBeNull();
    expect(tty.raw).toEqual([true, false]);
    expect(out.join('')).not.toContain('482');
  });
});
