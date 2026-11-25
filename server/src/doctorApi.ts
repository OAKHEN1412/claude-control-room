// HTTP API for the environment doctor: GET /api/doctor (cached 5 s, concurrent requests share one run) and
// POST /api/doctor/refresh (forces a new run). Loopback only; same origin rule as ClipApi.
import type http from 'node:http';
import { runDoctor, type DoctorReport } from './doctor';

const CACHE_MS = 5000;

export interface DoctorApiDeps {
  originAllowed: (origin: string | undefined) => boolean;
  run?: () => Promise<DoctorReport>;
}

export class DoctorApi {
  private readonly deps: DoctorApiDeps;
  private cached: DoctorReport | null = null;
  private cachedAt = 0;
  private inflight: Promise<DoctorReport> | null = null;

  constructor(deps: DoctorApiDeps) {
    this.deps = deps;
  }

  /** Starts one run; it becomes the in-flight run until it settles. */
  private start(): Promise<DoctorReport> {
    const run = this.deps.run ?? (() => runDoctor());
    const p = run().then((report) => {
      this.cached = report;
      this.cachedAt = Date.now();
      return report;
    });
    this.inflight = p;
    const clear = () => {
      if (this.inflight === p) this.inflight = null;
    };
    p.then(clear, clear);
    return p;
  }

  /** Cached report when younger than 5 s, else the in-flight run, else a new run. */
  current(): Promise<DoctorReport> {
    if (this.cached && Date.now() - this.cachedAt < CACHE_MS) return Promise.resolve(this.cached);
    return this.inflight ?? this.start();
  }

  /** Forces a new run; joins one only if it is already running. */
  refresh(): Promise<DoctorReport> {
    return this.inflight ?? this.start();
  }

  private json(res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
    res.end(JSON.stringify(body));
  }

  /** Returns true when the request was one of this API's routes (handled). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    if (p !== '/api/doctor' && p !== '/api/doctor/refresh') return false;
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
    const fail = () => this.json(res, 500, { ok: false, error: 'server error' }, cors);
    if (p === '/api/doctor' && req.method === 'GET') {
      this.current().then((r) => this.json(res, 200, r, cors), fail);
      return true;
    }
    if (p === '/api/doctor/refresh' && req.method === 'POST') {
      this.refresh().then((r) => this.json(res, 200, r, cors), fail);
      return true;
    }
    this.json(res, 405, { ok: false, error: 'method not allowed' }, cors);
    return true;
  }
}
