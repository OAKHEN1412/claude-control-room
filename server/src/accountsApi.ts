// HTTP API for the account profiles (server/src/accounts.ts). Same loopback + Origin rules and error style as
// settingsApi.ts. A token arrives once on PUT /api/accounts/:id/token, goes straight to the service and is never
// returned, echoed or logged: every response carries metadata only.
import type http from 'node:http';
import { ACCOUNT_ID_RE, validateProfileInput, type AccountInfo, type AccountsView } from '../../shared/accounts';

export interface AccountsPortApi {
  view(): AccountsView;
  create(input: { name: string; color?: string; letter?: string; note?: string }): AccountInfo;
  patch(id: string, patch: { name?: string; color?: string; letter?: string; note?: string; hidden?: boolean }): AccountInfo;
  remove(id: string): Promise<void>;
  setDefault(id: string): void;
  putToken(id: string, token: string): Promise<AccountInfo>;
  check(id: string): Promise<AccountInfo>;
  refreshUsage(id: string): Promise<AccountInfo>;
  connect(id: string): void;
  cancelConnect(): boolean;
  unlock(id: string, password: string): Promise<AccountInfo>;
  setPassword(id: string, input: { current?: string; next?: string }): Promise<AccountInfo>;
}

export interface AccountsApiDeps {
  originAllowed(origin: string | undefined): boolean;
  accounts: AccountsPortApi;
}

const BODY_CAP = 16 * 1024;

/** Errors whose code is safe to show. Never carries request content. */
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** Service error codes that map to a client status. Any other thrown value becomes 500 SERVER_ERROR. */
const CODE_STATUS = new Map<string, number>([
  ['NAME_INVALID', 400], ['COLOR_INVALID', 400], ['LETTER_INVALID', 400], ['NOTE_INVALID', 400],
  ['TOKEN_INVALID', 400], ['BAD_REQUEST', 400], ['BUILTIN', 400], ['ACCOUNT_NO_TOKEN', 400],
  ['NOT_FOUND', 404], ['ACCOUNT_UNKNOWN', 404],
  ['CONNECT_BUSY', 409],
  ['BAD_PASSWORD', 401], ['TOO_MANY_TRIES', 429], ['PROFILE_LOCKED', 423],
  ['PASSWORD_INVALID', 400], ['NO_PASSWORD', 400],
  ['PTY_UNAVAILABLE', 503], ['SECRETS_UNAVAILABLE', 503],
]);

/** Runner-side codes (CommandError, srv.<area>.<thing>) that map onto an API code. */
const SRV_ALIAS = new Map<string, string>([
  ['srv.account.noToken', 'ACCOUNT_NO_TOKEN'],
  ['srv.account.locked', 'PROFILE_LOCKED'],
]);

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  // AccountService errors (CodedError) carry the code on .srvCode; fall back to .code for other thrown values.
  const obj = typeof e === 'object' && e !== null ? (e as { srvCode?: unknown; code?: unknown }) : undefined;
  const raw = typeof obj?.srvCode === 'string' ? obj.srvCode : obj?.code;
  if (typeof raw === 'string') {
    const code = SRV_ALIAS.get(raw) ?? raw;
    const status = CODE_STATUS.get(code);
    if (status !== undefined) return new ApiError(status, code);
  }
  // Deliberately no message: a service error can quote its input, which may be a token.
  return new ApiError(500, 'SERVER_ERROR');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class AccountsApi {
  private readonly deps: AccountsApiDeps;

  constructor(deps: AccountsApiDeps) {
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

  /** Returns true only for /api/accounts and /api/accounts/* (handled or 404). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/accounts' && !url.pathname.startsWith('/api/accounts/')) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!this.deps.originAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
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
    const svc = this.deps.accounts;
    const m = req.method;
    // Path segments after /api/accounts: '' -> [], '/x/connect' -> ['x', 'connect'].
    const segs = url.pathname.slice('/api/accounts'.length).split('/').slice(1);

    if (segs.length === 0) {
      if (m === 'GET') {
        this.json(res, 200, svc.view(), cors);
        return;
      }
      if (m === 'POST') {
        const v = validateProfileInput(await this.readBody(req), false);
        if (!v.ok) throw new ApiError(400, v.error);
        if (v.value.name === undefined) throw new ApiError(400, 'NAME_INVALID');
        const account = svc.create({ ...v.value, name: v.value.name });
        this.json(res, 201, { ok: true, account }, cors);
        return;
      }
      throw new ApiError(404, 'NOT_FOUND');
    }

    const [first, ...rest] = segs;
    // Matched before the :id routes, so PUT /api/accounts/default is never read as an account id.
    if (first === 'default') {
      if (rest.length === 0 && m === 'PUT') {
        const body = await this.readBody(req);
        const accountId = isPlainObject(body) && typeof body.accountId === 'string' ? body.accountId : null;
        if (accountId === null) throw new ApiError(400, 'BAD_REQUEST');
        if (!ACCOUNT_ID_RE.test(accountId)) throw new ApiError(404, 'NOT_FOUND');
        svc.setDefault(accountId);
        this.json(res, 200, { ok: true, defaultId: svc.view().defaultId }, cors);
        return;
      }
      throw new ApiError(404, 'NOT_FOUND');
    }

    if (!ACCOUNT_ID_RE.test(first)) throw new ApiError(404, 'NOT_FOUND');
    const id = first;

    switch ([m, ...rest].join(' ')) {
      case 'PATCH': {
        const body = await this.readBody(req);
        const v = validateProfileInput(body, true);
        if (!v.ok) throw new ApiError(400, v.error);
        const patch: { name?: string; color?: string; letter?: string; note?: string; hidden?: boolean } = { ...v.value };
        if (isPlainObject(body) && body.hidden !== undefined) {
          if (typeof body.hidden !== 'boolean') throw new ApiError(400, 'BAD_REQUEST');
          patch.hidden = body.hidden;
        }
        this.json(res, 200, { ok: true, account: svc.patch(id, patch) }, cors);
        return;
      }
      case 'DELETE':
        await svc.remove(id);
        this.json(res, 200, { ok: true }, cors);
        return;
      case 'POST connect':
        svc.connect(id);
        this.json(res, 202, { ok: true }, cors);
        return;
      case 'POST connect cancel':
        this.json(res, 200, { ok: true, cancelled: svc.cancelConnect() }, cors);
        return;
      case 'PUT token': {
        const body = await this.readBody(req);
        // Only the type is checked here; the service validates the format (TOKEN_RE).
        const token = isPlainObject(body) && typeof body.token === 'string' ? body.token : null;
        if (token === null) throw new ApiError(400, 'TOKEN_INVALID');
        this.json(res, 200, { ok: true, account: await svc.putToken(id, token) }, cors);
        return;
      }
      case 'POST unlock': {
        const body = await this.readBody(req);
        // A wrong password is BAD_PASSWORD from the service; a missing or non-string field is a malformed request.
        const password = isPlainObject(body) && typeof body.password === 'string' ? body.password : null;
        if (password === null) throw new ApiError(400, 'BAD_REQUEST');
        this.json(res, 200, { ok: true, account: await svc.unlock(id, password) }, cors);
        return;
      }
      case 'PUT password': {
        const body = await this.readBody(req);
        if (!isPlainObject(body)) throw new ApiError(400, 'BAD_REQUEST');
        if ((body.current !== undefined && typeof body.current !== 'string') || (body.next !== undefined && typeof body.next !== 'string')) {
          throw new ApiError(400, 'BAD_REQUEST');
        }
        const input: { current?: string; next?: string } = {};
        if (typeof body.current === 'string') input.current = body.current;
        if (typeof body.next === 'string') input.next = body.next;
        this.json(res, 200, { ok: true, account: await svc.setPassword(id, input) }, cors);
        return;
      }
      case 'POST check':
        this.json(res, 200, { ok: true, account: await svc.check(id) }, cors);
        return;
      case 'POST refresh-usage':
        this.json(res, 200, { ok: true, account: await svc.refreshUsage(id) }, cors);
        return;
      default:
        throw new ApiError(404, 'NOT_FOUND');
    }
  }
}
