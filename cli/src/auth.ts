// App lock for the `cr` CLI. When the server has an app PIN (6 digits), the CLI unlocks once per process, keeps
// the session cookie in memory only, and sends it on the WebSocket handshake. Pure logic: HTTP, stdin and TTY are
// injected, so the tests use fakes. The PIN and the cookie are never printed, logged, or written anywhere.
// The server closes a locked WebSocket with APP_LOCK_CLOSE_CODE.
import { validatePin } from '../../shared/accounts.ts';

export const APP_LOCK_CLOSE_CODE = 4401;
export const APP_LOCK_HINT = 'แอปล็อกอยู่ — ใช้ --pin-stdin หรือพิมพ์ PIN';
export const AUTH_STATE_TIMEOUT_MS = 3000;
/** Wrong PINs the server accepts per prompt round (each one is a server call). */
export const MAX_PIN_ATTEMPTS = 3;
/** Malformed PINs re-prompted locally, without contacting the server. */
export const MAX_PIN_FORMAT_TRIES = 3;
const SESSION_COOKIE = 'cr_session';

/** The part of a TTY stdin that the no-echo prompt needs. */
export interface TtyInput {
  setRawMode(on: boolean): unknown;
  setEncoding(encoding: 'utf8'): unknown;
  on(event: 'data', fn: (chunk: string | Buffer) => void): unknown;
  removeListener(event: 'data', fn: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The part of a stdin stream that the --pin-stdin line reader needs. */
export interface LineInput {
  setEncoding(encoding: 'utf8'): unknown;
  on(event: 'data' | 'end', fn: (chunk?: string | Buffer) => void): unknown;
  removeListener(event: 'data' | 'end', fn: (chunk?: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface AuthIo {
  fetch: typeof fetch;
  stdinIsTTY: boolean;
  /** Reads the first line of stdin (for --pin-stdin). Resolves with '' at end of input. */
  readStdinLine: () => Promise<string>;
  /** Prompts with no echo. Resolves with null when the user cancels (Ctrl-C / Ctrl-D). */
  readTtyPassword: (prompt: string) => Promise<string | null>;
}

export type UnlockResult = { ok: true; cookie?: string } | { ok: false; error: string };

/** m:ss for a wait in milliseconds, rounded up to whole seconds. 754000 -> "12:34". */
export function formatWait(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface AuthState {
  required: boolean;
  unlocked: boolean;
}

const NOT_REQUIRED: AuthState = { required: false, unlocked: true };

/** Asks the server whether the app lock is on. Any failure (timeout, refused, 404 from an old server) = not required. */
export async function getAuthState(base: string, f: typeof fetch, timeoutMs = AUTH_STATE_TIMEOUT_MS): Promise<AuthState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const res = await Promise.race([f(`${base}/api/auth/state`), timeout]);
    if (!res || !res.ok) return NOT_REQUIRED;
    const body: unknown = await res.json();
    if (!isObject(body) || typeof body.required !== 'boolean') return NOT_REQUIRED;
    return { required: body.required, unlocked: body.unlocked === true };
  } catch {
    return NOT_REQUIRED;
  } finally {
    clearTimeout(timer);
  }
}

/** Pulls `cr_session=<sid>` out of a Set-Cookie header value. Attributes (HttpOnly, Path...) are dropped. */
export function sessionCookieOf(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined;
  const m = new RegExp(`(?:^|[,\\s])${SESSION_COOKIE}=([A-Za-z0-9_-]{16,256})(?=;|,|\\s|$)`).exec(setCookie);
  return m ? `${SESSION_COOKIE}=${m[1]}` : undefined;
}

export interface UnlockOptions {
  base: string;
  /** --pin-stdin (alias --password-stdin): the PIN is the first line of stdin. */
  pinStdin: boolean;
  io: AuthIo;
  /** Thai progress text for the user (never contains the PIN). */
  notify: (msg: string) => void;
}

/** Asks for a PIN until it has exactly 6 digits. Malformed input never reaches the server. */
async function readValidPin(o: UnlockOptions): Promise<{ ok: true; pin: string } | { ok: false; error: string }> {
  for (let n = 1; n <= MAX_PIN_FORMAT_TRIES; n++) {
    const raw = o.pinStdin ? await o.io.readStdinLine() : await o.io.readTtyPassword('PIN: ');
    if (raw === null) return { ok: false, error: 'ยกเลิกการใส่ PIN' };
    if (validatePin(raw)) return { ok: true, pin: raw };
    if (o.pinStdin) return { ok: false, error: raw === '' ? 'ไม่มี PIN ใน stdin' : 'PIN ต้องเป็นตัวเลข 6 หลัก' };
    if (n < MAX_PIN_FORMAT_TRIES) o.notify(`PIN ต้องเป็นตัวเลข 6 หลัก (เหลือ ${MAX_PIN_FORMAT_TRIES - n} ครั้ง)`);
  }
  return { ok: false, error: `PIN ต้องเป็นตัวเลข 6 หลัก (ลองครบ ${MAX_PIN_FORMAT_TRIES} ครั้งแล้ว)` };
}

/** retryAfterMs from the 429 body, or null when the server did not send one. */
async function retryAfterMsOf(res: Response): Promise<number | null> {
  try {
    const body: unknown = await res.json();
    if (isObject(body) && typeof body.retryAfterMs === 'number' && Number.isFinite(body.retryAfterMs) && body.retryAfterMs >= 0) {
      return body.retryAfterMs;
    }
  } catch {
    // no JSON body: the generic text is used
  }
  return null;
}

/** Makes sure this process can reach a locked server. Returns the cookie to send with the WebSocket, if any. */
export async function unlockIfRequired(o: UnlockOptions): Promise<UnlockResult> {
  const state = await getAuthState(o.base, o.io.fetch);
  if (!state.required || state.unlocked) return { ok: true };

  if (!o.pinStdin && !o.io.stdinIsTTY) {
    return { ok: false, error: 'แอปล็อกอยู่ และไม่ได้รันใน terminal — ใช้ --pin-stdin (ส่ง PIN 6 หลักบรรทัดแรกของ stdin)' };
  }

  for (let attempt = 1; attempt <= MAX_PIN_ATTEMPTS; attempt++) {
    const got = await readValidPin(o);
    if (!got.ok) return got;

    let res: Response;
    try {
      // The request field is still named "password" on the server side; its value is the PIN.
      res = await o.io.fetch(`${o.base}/api/auth/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: got.pin }),
      });
    } catch {
      return { ok: false, error: 'ปลดล็อกไม่ได้: เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' };
    }

    if (res.status === 200) {
      const cookie = sessionCookieOf(res.headers.get('set-cookie'));
      if (!cookie) return { ok: false, error: 'ปลดล็อกไม่สำเร็จ: เซิร์ฟเวอร์ไม่ได้ส่งสิทธิ์เข้าใช้' };
      return { ok: true, cookie };
    }
    if (res.status === 429) {
      const ms = await retryAfterMsOf(res);
      return {
        ok: false,
        error: ms === null ? 'ใส่ PIN ผิดหลายครั้งเกินไป — ลองใหม่ทีหลัง' : `ใส่ PIN ผิดหลายครั้งเกินไป — ลองใหม่ได้ใน ${formatWait(ms)}`,
      };
    }
    if (res.status !== 401) return { ok: false, error: `ปลดล็อกไม่สำเร็จ (HTTP ${res.status})` };

    // wrong PIN: stdin holds one line only, so it gets one try
    if (o.pinStdin) return { ok: false, error: 'PIN ไม่ถูกต้อง' };
    if (attempt < MAX_PIN_ATTEMPTS) o.notify(`PIN ไม่ถูกต้อง (เหลือ ${MAX_PIN_ATTEMPTS - attempt} ครั้ง)`);
  }
  return { ok: false, error: `PIN ไม่ถูกต้อง (ลองครบ ${MAX_PIN_ATTEMPTS} ครั้งแล้ว)` };
}

/** True when a connect failure is the server closing the WebSocket because the app is locked. */
export function isAppLockClose(e: unknown): boolean {
  return isObject(e) && e.code === APP_LOCK_CLOSE_CODE;
}

/** Reads one line from a stream (the first '\n', or everything at end of input). The line is returned without its CR. */
export function readStdinLine(input: LineInput): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.pause();
      const nl = buf.indexOf('\n');
      resolve((nl >= 0 ? buf.slice(0, nl) : buf).replace(/\r$/, ''));
    };
    const onData = (chunk?: string | Buffer): void => {
      buf += typeof chunk === 'string' ? chunk : String(chunk ?? '');
      if (buf.includes('\n')) finish();
    };
    const onEnd = (): void => finish();
    input.setEncoding('utf8');
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume();
  });
}

/**
 * Reads a password from a TTY with no echo. Enter ends the line, Backspace deletes, Ctrl-C / Ctrl-D cancel (null).
 * Only the prompt is written to `output`; typed characters are never echoed.
 */
export function readTtyPassword(input: TtyInput, output: { write(s: string): unknown }, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = '';
    const finish = (value: string | null): void => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      resolve(value);
    };
    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of Array.from(text)) {
        if (ch === '\r' || ch === '\n') return finish(buf);
        if (ch === '\u0003' || ch === '\u0004') return finish(null);
        if (ch === '\u007f' || ch === '\b') {
          buf = Array.from(buf).slice(0, -1).join('');
          continue;
        }
        if (ch === '\u001b') return; // escape sequences (arrow keys...) are ignored
        if (ch < ' ') continue;
        buf += ch;
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
