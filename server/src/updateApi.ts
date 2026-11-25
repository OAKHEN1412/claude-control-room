// HTTP API for the update banner: status, manual check, apply (now or once the server is idle), cancel.
// Loopback only, same Origin rule as api.ts. The tag handed to the updater always comes from the checker,
// never from the request body.
import type http from 'node:http';
import type { UpdateChecker } from './updateCheck';

export interface UpdateApiDeps {
  originAllowed: (origin: string | undefined) => boolean;
  checker: UpdateChecker;
  canUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  busy: () => { running: number; waiting: number; clips: number };
  startUpdater: (tag: string) => Promise<{ ok: boolean; error?: string }>;
  /** ms between idle checks while an apply is scheduled. Default 30000. */
  poll?: number;
}

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const MAX_BODY = 8 * 1024;

class BodyError extends Error {}

export class UpdateApi {
  private readonly deps: UpdateApiDeps;
  private readonly poll: number;
  private scheduled = false;
  private applying = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: UpdateApiDeps) {
    this.deps = deps;
    this.poll = deps.poll ?? 30000;
  }

  /** Returns true when the request was an /api/update route (handled). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    if (p !== '/api/update' && !p.startsWith('/api/update/')) return false;
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
    void this.route(req, res, p, cors).catch(() => {
      this.json(res, 500, { ok: false, error: 'server error' }, cors);
    });
    return true;
  }

  /** Clears any scheduled apply. Call on shutdown. */
  stop(): void {
    this.clearSchedule();
  }

  private json(res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
    res.end(JSON.stringify(body));
  }

  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      let failed = false;
      req.on('data', (c: Buffer) => {
        if (failed) return;
        n += c.length;
        if (n > MAX_BODY) {
          failed = true;
          reject(new BodyError('body-too-large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (failed) return;
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new BodyError('bad-json'));
        }
      });
      req.on('error', reject);
    });
  }

  private busyCount(): number {
    const b = this.deps.busy();
    return b.running + b.waiting + b.clips;
  }

  private async payload() {
    let canUpdate: { ok: boolean; reason?: string };
    try {
      canUpdate = await this.deps.canUpdate();
    } catch {
      canUpdate = { ok: false, reason: 'check-failed' };
    }
    return {
      ...this.deps.checker.status(),
      canUpdate,
      busy: this.deps.busy(),
      scheduled: this.scheduled,
      applying: this.applying,
    };
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, p: string, cors: Record<string, string>): Promise<void> {
    const m = req.method;
    if (m === 'GET' && p === '/api/update') {
      this.json(res, 200, await this.payload(), cors);
      return;
    }
    if (m === 'POST' && p === '/api/update/check') {
      await this.deps.checker.checkNow();
      this.json(res, 200, await this.payload(), cors);
      return;
    }
    if (m === 'POST' && p === '/api/update/apply') {
      await this.apply(req, res, cors);
      return;
    }
    if (m === 'POST' && p === '/api/update/cancel') {
      this.clearSchedule();
      this.json(res, 200, { ok: true, scheduled: false, applying: this.applying }, cors);
      return;
    }
    this.json(res, 404, { ok: false, error: 'not-found' }, cors);
  }

  private async apply(req: http.IncomingMessage, res: http.ServerResponse, cors: Record<string, string>): Promise<void> {
    let body: unknown;
    try {
      body = await this.readBody(req);
    } catch (e) {
      this.json(res, 400, { ok: false, error: e instanceof BodyError ? e.message : 'bad-json' }, cors);
      return;
    }
    const whenIdle = typeof body === 'object' && body !== null && (body as Record<string, unknown>).whenIdle === true;

    if (this.applying) {
      this.json(res, 409, { ok: false, error: 'already-applying' }, cors);
      return;
    }
    if (this.scheduled) {
      this.json(res, 409, { ok: false, error: 'already-scheduled' }, cors);
      return;
    }
    const st = this.deps.checker.status();
    if (!st.latest || !st.available) {
      this.json(res, 409, { ok: false, error: 'no-update' }, cors);
      return;
    }
    let can: { ok: boolean; reason?: string };
    try {
      can = await this.deps.canUpdate();
    } catch {
      can = { ok: false, reason: 'check-failed' };
    }
    if (!can.ok) {
      this.json(res, 409, { ok: false, error: 'cannot-update', reason: can.reason }, cors);
      return;
    }
    const tag = st.latest.tag;
    if (!TAG_RE.test(tag)) {
      this.json(res, 400, { ok: false, error: 'bad-tag' }, cors);
      return;
    }
    if (this.busyCount() > 0) {
      if (!whenIdle) {
        this.json(res, 409, { ok: false, error: 'busy', busy: this.deps.busy() }, cors);
        return;
      }
      this.schedule(tag);
      this.json(res, 200, { ok: true, applying: false, scheduled: true }, cors);
      return;
    }
    const r = await this.fire(tag);
    if (!r.ok) {
      this.json(res, 500, { ok: false, error: r.error ?? 'start-failed' }, cors);
      return;
    }
    this.json(res, 200, { ok: true, applying: true }, cors);
  }

  /** Starts the updater once. Sets `applying` only on success. */
  private async fire(tag: string): Promise<{ ok: boolean; error?: string }> {
    this.applying = true;
    let r: { ok: boolean; error?: string };
    try {
      r = await this.deps.startUpdater(tag);
    } catch {
      r = { ok: false, error: 'start-failed' };
    }
    if (!r.ok) this.applying = false;
    return r;
  }

  private schedule(tag: string): void {
    this.clearSchedule();
    this.scheduled = true;
    this.timer = setInterval(() => {
      if (this.busyCount() > 0) return;
      this.clearSchedule();
      void this.fire(tag);
    }, this.poll);
  }

  private clearSchedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.scheduled = false;
  }
}
