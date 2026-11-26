// HTTP API for the main account's claude.ai login (server/src/mainAccount.ts). Same loopback + Origin rules, body cap
// and error style as accountsApi.ts. The pasted login code arrives once on POST .../login/code, goes straight to the
// service and is never echoed, logged or returned. Only paths under /api/accounts/main are handled here.
import type http from 'node:http';
import type { MainAccountInfo } from '../../shared/accounts';

export interface MainAccountPortApi {
  status(force?: boolean): Promise<MainAccountInfo>;
  login(): void;
  writeCode(code: string): void;
  cancelLogin(): boolean;
  logout(): Promise<MainAccountInfo>;
}

export interface MainAuthApiDeps {
  originAllowed(origin: string | undefined): boolean;
  main: MainAccountPortApi;
}

const BASE = '/api/accounts/main';
const BODY_CAP = 16 * 1024;

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** Service error codes that map to a client status. Any other thrown value becomes 500 SERVER_ERROR. */
const CODE_STATUS = new Map<string, number>([
  ['CODE_INVALID', 400],
  ['BAD_REQUEST', 400],
  ['LOGIN_BUSY', 409],
  ['NO_LOGIN_RUNNING', 409],
  ['BUSY_JOBS', 409],
  ['PTY_UNAVAILABLE', 503],
]);

/** Deliberately no message: a service error can quote its input, which may be a login code. */
function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const raw = typeof e === 'object' && e !== null ? (e as { srvCode?: unknown }).srvCode : undefined;
  if (typeof raw === 'string') {
    const status = CODE_STATUS.get(raw);
    if (status !== undefined) return new ApiError(status, raw);
  }
  return new ApiError(500, 'SERVER_ERROR');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class MainAuthApi {
  private readonly deps: MainAuthApiDeps;

  constructor(deps: MainAuthApiDeps) {
    this.deps = deps;
  }

  private json(res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
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

  /** Returns true only for /api/accounts/main and /api/accounts/main/* (handled or 404). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== BASE && !url.pathname.startsWith(BASE + '/')) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!this.deps.originAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return true;
    }
    void this.route(req, res, url, cors).catch((e) => {
      const err = toApiError(e);
      this.json(res, err.status, { ok: false, error: err.code }, cors);
    });
    return true;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, cors: Record<string, string>): Promise<void> {
    const main = this.deps.main;
    const m = req.method;
    // '' for the base path, 'login/code' for /api/accounts/main/login/code.
    const sub = url.pathname.slice(BASE.length).replace(/^\//, '');

    if (sub === '') {
      if (m !== 'GET') throw new ApiError(404, 'NOT_FOUND');
      const fresh = url.searchParams.get('fresh') === '1';
      this.json(res, 200, await main.status(fresh), cors);
      return;
    }

    switch (`${m} ${sub}`) {
      case 'POST login':
        main.login();
        this.json(res, 202, { ok: true }, cors);
        return;
      case 'POST login/code': {
        const body = await this.readBody(req);
        // Only the type is checked here; the service validates the code (validateLoginCode).
        const code = isPlainObject(body) && typeof body.code === 'string' ? body.code : null;
        if (code === null) throw new ApiError(400, 'CODE_INVALID');
        main.writeCode(code);
        this.json(res, 200, { ok: true }, cors);
        return;
      }
      case 'POST login/cancel':
        this.json(res, 200, { ok: true, cancelled: main.cancelLogin() }, cors);
        return;
      case 'POST logout':
        this.json(res, 200, { ok: true, main: await main.logout() }, cors);
        return;
      default:
        throw new ApiError(404, 'NOT_FOUND');
    }
  }
}
