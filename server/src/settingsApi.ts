// HTTP API for the Settings page: reads and writes <dataDir>/config.json and the ElevenLabs key. The key goes
// through a SecretsAdmin and is never returned, echoed or logged. Loopback only; same origin rules as ClipApi.
import type http from 'node:http';
import { dataDir } from './cmdlog';
import { configFile, envOverrides, loadConfig, saveConfig, validateConfigPatch, type CrConfig } from './config';

export interface SecretsAdmin {
  has(name: string): Promise<boolean>;
  set(name: string, value: string): Promise<void>;
  clear(name: string): Promise<void>;
}

export interface SettingsApiDeps {
  originAllowed: (origin: string | undefined) => boolean;
  dir?: string;
  secrets?: SecretsAdmin;
  onChange?: (cfg: CrConfig) => void;
  env?: NodeJS.ProcessEnv;
}

const BODY_CAP = 16 * 1024;
const SECRET_NAME = 'elevenlabs';
const SECRET_MIN = 8;
const SECRET_MAX = 200;

/** Errors whose code is safe to show. Never carries request content. */
class SettingsError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class SettingsApi {
  private readonly deps: SettingsApiDeps;

  constructor(deps: SettingsApiDeps) {
    this.deps = deps;
  }

  private dir(): string {
    return this.deps.dir ?? dataDir();
  }

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
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
          reject(new SettingsError(413, 'BODY_TOO_LARGE'));
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
          reject(new SettingsError(400, 'BAD_JSON'));
        }
      });
      req.on('error', () => reject(new SettingsError(400, 'BAD_REQUEST')));
    });
  }

  private async secretState(): Promise<{ elevenlabs: 'set' | 'unset' }> {
    const s = this.deps.secrets;
    if (!s) return { elevenlabs: 'unset' };
    try {
      return { elevenlabs: (await s.has(SECRET_NAME)) ? 'set' : 'unset' };
    } catch {
      return { elevenlabs: 'unset' };
    }
  }

  private async state(): Promise<Record<string, unknown>> {
    const dir = this.dir();
    const loaded = loadConfig(dir);
    return {
      config: loaded.config,
      warnings: loaded.warnings,
      envOverrides: envOverrides(this.env()),
      secrets: await this.secretState(),
      dataDir: dir,
      file: configFile(dir),
    };
  }

  /** Returns true only for /api/settings and /api/settings/* (handled or 404). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/settings' && !url.pathname.startsWith('/api/settings/')) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!this.deps.originAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return true;
    }
    void this.route(req, res, url, cors).catch((e) => {
      if (e instanceof SettingsError) this.json(res, e.status, { ok: false, error: e.code }, cors);
      else this.json(res, 500, { ok: false, error: 'server error' }, cors);
    });
    return true;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, cors: Record<string, string>): Promise<void> {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/settings') {
      if (m === 'GET') {
        this.json(res, 200, await this.state(), cors);
        return;
      }
      if (m === 'PUT') {
        const v = validateConfigPatch(await this.readBody(req));
        if (!v.ok) {
          this.json(res, 400, { ok: false, error: v.error }, cors);
          return;
        }
        const cfg = saveConfig(v.patch, this.dir());
        try {
          this.deps.onChange?.(cfg);
        } catch {
          // a listener failure must not turn a saved change into an error response
        }
        this.json(res, 200, { ok: true, ...(await this.state()) }, cors);
        return;
      }
    }
    if (p === '/api/settings/secret/elevenlabs' && (m === 'PUT' || m === 'DELETE')) {
      const s = this.deps.secrets;
      if (!s) {
        this.json(res, 503, { ok: false, error: 'SECRETS_UNAVAILABLE' }, cors);
        return;
      }
      if (m === 'PUT') {
        const body = await this.readBody(req);
        const value = isPlainObject(body) && typeof body.value === 'string' ? body.value.trim() : null;
        if (value === null || value.length < SECRET_MIN || value.length > SECRET_MAX || /\s/.test(value)) {
          this.json(res, 400, { ok: false, error: 'INVALID_VALUE' }, cors);
          return;
        }
        await s.set(SECRET_NAME, value);
      } else {
        await s.clear(SECRET_NAME);
      }
      this.json(res, 200, { ok: true, secrets: await this.secretState() }, cors);
      return;
    }
    this.json(res, 404, { ok: false, error: 'NOT_FOUND' }, cors);
  }
}
