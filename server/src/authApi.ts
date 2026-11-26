// HTTP API for the app lock (server/src/appLock.ts). Same loopback + Origin rules, body cap and error style as
// accountsApi.ts. The PIN (6 digits) arrives in a body, goes straight to AppLock and is never returned or logged.
import type http from 'node:http';
import { validatePin } from '../../shared/accounts';
import { AppLockError, IN_FLIGHT_RETRY_MS, type AppLock } from './appLock';

export interface AuthApiDeps {
  originAllowed(origin: string | undefined): boolean;
  lock: AppLock;
}

const BODY_CAP = 16 * 1024;

/** Errors whose code is safe to show. Never carries request content. retryAfterMs only with TOO_MANY_TRIES. */
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterMs?: number) {
    super(code);
  }
}

const LOCK_ERROR_STATUS: Record<string, [number, string]> = {
  PIN_INVALID: [400, 'PIN_INVALID'],
  BAD_PASSWORD: [401, 'BAD_PASSWORD'],
  TOO_MANY_TRIES: [429, 'TOO_MANY_TRIES'],
  NO_PASSWORD: [400, 'NO_PASSWORD'],
};

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof AppLockError) {
    const mapped = LOCK_ERROR_STATUS[e.code];
    if (mapped) return new ApiError(mapped[0], mapped[1], e.code === 'TOO_MANY_TRIES' ? e.retryAfterMs : undefined);
  }
  // Deliberately no message: it must never be able to carry a password.
  return new ApiError(500, 'SERVER_ERROR');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class AuthApi {
  private readonly deps: AuthApiDeps;

  constructor(deps: AuthApiDeps) {
    this.deps = deps;
  }

  private json(res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>, extra: Record<string, string> = {}): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors, ...extra });
    res.end(JSON.stringify(body));
  }

  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      let over = false;
      req.on('data', (c: Buffer) => {
        if (over) return;
        n += c.length;
        if (n > BODY_CAP) {
          // Keep draining (ignored) so the 413 can still be written; the body is never buffered past the cap.
          over = true;
          chunks.length = 0;
          reject(new ApiError(413, 'BODY_TOO_LARGE'));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (over) return;
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text || '{}'));
        } catch {
          // Deliberately not echoing the parser message: it can quote part of the body.
          reject(new ApiError(400, 'BAD_JSON'));
        }
      });
      req.on('error', () => reject(new ApiError(400, 'BAD_REQUEST')));
    });
  }

  /** Returns true for /api/auth and /api/auth/* (handled or 404). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/auth' && !url.pathname.startsWith('/api/auth/')) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!this.deps.originAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    const cors: Record<string, string> = origin
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' }
      : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return true;
    }
    void this.route(req, res, url, cors).catch((e) => {
      const err = toApiError(e);
      if (err.retryAfterMs !== undefined) {
        // Retry-After is whole seconds, rounded up; the body keeps the exact milliseconds.
        const headers = { 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) };
        this.json(res, err.status, { ok: false, error: err.code, retryAfterMs: err.retryAfterMs }, cors, headers);
        return;
      }
      this.json(res, err.status, { ok: false, error: err.code }, cors);
    });
    return true;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, cors: Record<string, string>): Promise<void> {
    const lock = this.deps.lock;
    const m = req.method;
    const p = url.pathname;
    const cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;

    if (p === '/api/auth/state' && m === 'GET') {
      const required = lock.configured();
      this.json(res, 200, { required, unlocked: !required || lock.hasSession(cookie) }, cors);
      return;
    }

    if (p === '/api/auth/unlock' && m === 'POST') {
      const body = await this.readBody(req);
      const pin = isPlainObject(body) && typeof body.password === 'string' ? body.password : null;
      if (pin === null) throw new ApiError(400, 'BAD_REQUEST');
      // Format first: a malformed PIN never reaches scrypt and is not counted as a wrong try.
      if (!validatePin(pin)) throw new ApiError(400, 'PIN_INVALID');
      if (!lock.configured()) {
        this.json(res, 200, { ok: true, required: false, unlocked: true }, cors);
        return;
      }
      const r = await lock.verify(pin);
      if (r === 'wait') throw new ApiError(429, 'TOO_MANY_TRIES', Math.max(lock.retryAfterMs(), IN_FLIGHT_RETRY_MS));
      if (r !== 'ok') throw new ApiError(401, 'BAD_PASSWORD');
      const sid = lock.createSession();
      this.json(res, 200, { ok: true, required: true, unlocked: true }, cors, { 'Set-Cookie': lock.cookieHeader(sid) });
      return;
    }

    if (p === '/api/auth/lock' && m === 'POST') {
      lock.dropSession(cookie);
      this.json(res, 200, { ok: true, required: lock.configured(), unlocked: false }, cors, { 'Set-Cookie': lock.clearCookieHeader() });
      return;
    }

    if (p === '/api/auth/password' && m === 'PUT') {
      // With a PIN set, changing or removing it needs a live session as well as the current PIN.
      if (lock.configured() && !lock.hasSession(cookie)) throw new ApiError(401, 'LOCKED');
      const body = await this.readBody(req);
      if (!isPlainObject(body)) throw new ApiError(400, 'BAD_REQUEST');
      const current = typeof body.current === 'string' ? body.current : undefined;
      const next = typeof body.next === 'string' ? body.next : undefined;
      if (body.current !== undefined && current === undefined) throw new ApiError(400, 'BAD_REQUEST');
      if (body.next !== undefined && next === undefined) throw new ApiError(400, 'BAD_REQUEST');

      if (next === undefined) {
        // No next PIN: remove. Needs a set PIN and the current one (format and throttle checked in AppLock).
        if (!lock.configured()) throw new ApiError(400, 'NO_PASSWORD');
        await lock.remove(current);
        this.json(res, 200, { ok: true, required: false, unlocked: true }, cors);
        return;
      }
      // Set (none configured yet, no current needed) or change (current must verify). Both clear every session,
      // so this caller gets a fresh session cookie to stay signed in.
      await lock.set(next, current);
      const sid = lock.createSession();
      this.json(res, 200, { ok: true, required: true, unlocked: true }, cors, { 'Set-Cookie': lock.cookieHeader(sid) });
      return;
    }

    if (p === '/api/auth/state' || p === '/api/auth/unlock' || p === '/api/auth/lock' || p === '/api/auth/password') {
      throw new ApiError(405, 'METHOD_NOT_ALLOWED');
    }
    throw new ApiError(404, 'NOT_FOUND');
  }
}
