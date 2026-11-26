import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configFile, loadAppLock, saveAppLock, type AppLockRecord, type CrConfig } from '../src/config';
import { SettingsApi, type SecretsAdmin } from '../src/settingsApi';

// Fake key only. Never a real credential.
const FAKE = 'sk_test_0000000000000000';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-settings-'));
  tmp.push(d);
  return d;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeSecrets(): SecretsAdmin & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    has: async (n) => store.has(n),
    set: async (n, v) => {
      store.set(n, v);
    },
    clear: async (n) => {
      store.delete(n);
    },
  };
}

interface Started {
  base: string;
  api: SettingsApi;
}

async function start(opts: { dir: string; secrets?: SecretsAdmin; onChange?: (c: CrConfig) => void; env?: NodeJS.ProcessEnv }): Promise<Started> {
  const api = new SettingsApi({
    originAllowed: (o) => o === undefined || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(o),
    dir: opts.dir,
    secrets: opts.secrets,
    onChange: opts.onChange,
    env: opts.env ?? {},
  });
  const server = http.createServer((req, res) => {
    if (!api.handle(req, res)) {
      res.writeHead(418);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, api };
}

interface Resp {
  status: number;
  text: string;
  json: any;
  headers: http.IncomingHttpHeaders;
}

function call(base: string, method: string, urlPath: string, opts: { body?: unknown; raw?: string; origin?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const headers: Record<string, string> = {};
    if (opts.origin) headers.Origin = opts.origin;
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const u = new URL(base + urlPath);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('SettingsApi routing', () => {
  it('returns false for paths it does not own', () => {
    const api = new SettingsApi({ originAllowed: () => true, dir: tmpDir(), env: {} });
    const fakeReq = { url: '/api/clip-config', method: 'GET', headers: {} } as unknown as http.IncomingMessage;
    const fakeRes = {} as http.ServerResponse;
    expect(api.handle(fakeReq, fakeRes)).toBe(false);
    const fakeReq2 = { url: '/api/settingsX', method: 'GET', headers: {} } as unknown as http.IncomingMessage;
    expect(api.handle(fakeReq2, fakeRes)).toBe(false);
  });
});

describe('SettingsApi over HTTP', () => {
  it('GET /api/settings returns the state shape with secrets unset and no secrets admin', async () => {
    const dir = tmpDir();
    const s = await start({ dir, env: { CR_PORT: '9100' } });
    const r = await call(s.base, 'GET', '/api/settings');
    expect(r.status).toBe(200);
    expect(r.json.config.language).toBe('auto');
    expect(r.json.warnings).toEqual([]);
    expect(r.json.envOverrides).toEqual({ port: true, galleryRoots: false, videosDir: false, extraCwds: false });
    expect(r.json.secrets).toEqual({ elevenlabs: 'unset' });
    expect(r.json.dataDir).toBe(dir);
    expect(r.json.file).toBe(configFile(dir));
  });

  it('PUT /api/settings saves, calls onChange, and answers with the state plus ok', async () => {
    const dir = tmpDir();
    const onChange = vi.fn();
    const s = await start({ dir, onChange });
    const r = await call(s.base, 'PUT', '/api/settings', { body: { language: 'th', update: { check: false } } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.config.language).toBe('th');
    expect(r.json.config.update).toEqual({ check: false, channel: 'stable' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].language).toBe('th');
    expect(fs.existsSync(configFile(dir))).toBe(true);

    const g = await call(s.base, 'GET', '/api/settings');
    expect(g.json.config.language).toBe('th');
  });

  it('PUT /api/settings rejects invalid patches with 400 and does not save', async () => {
    const dir = tmpDir();
    const onChange = vi.fn();
    const s = await start({ dir, onChange });
    const r = await call(s.base, 'PUT', '/api/settings', { body: { language: 'fr' } });
    expect(r.status).toBe(400);
    expect(r.json.ok).toBe(false);
    expect(typeof r.json.error).toBe('string');
    const r2 = await call(s.base, 'PUT', '/api/settings', { body: { mystery: 1 } });
    expect(r2.status).toBe(400);
    expect(onChange).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile(dir))).toBe(false);
  });

  it('malformed JSON gives 400 BAD_JSON without echoing the body', async () => {
    const s = await start({ dir: tmpDir(), secrets: fakeSecrets() });
    const r = await call(s.base, 'PUT', '/api/settings', { raw: '{"language": nope' });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'BAD_JSON' });
  });

  it('a body over 16 KB gives 413', async () => {
    const s = await start({ dir: tmpDir() });
    const big = JSON.stringify({ galleryRoots: ['a'.repeat(17 * 1024)] });
    const r = await call(s.base, 'PUT', '/api/settings', { raw: big });
    expect(r.status).toBe(413);
    expect(r.json.error).toBe('BODY_TOO_LARGE');
  });

  it('unknown /api/settings paths give 404 JSON', async () => {
    const s = await start({ dir: tmpDir(), secrets: fakeSecrets() });
    const r = await call(s.base, 'GET', '/api/settings/nope');
    expect(r.status).toBe(404);
    expect(r.json.ok).toBe(false);
    const r2 = await call(s.base, 'GET', '/api/settings/secret/elevenlabs');
    expect(r2.status).toBe(404);
  });

  it('secret PUT sets, GET reports set, DELETE clears', async () => {
    const secrets = fakeSecrets();
    const s = await start({ dir: tmpDir(), secrets });
    const put = await call(s.base, 'PUT', '/api/settings/secret/elevenlabs', { body: { value: `  ${FAKE}  ` } });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ ok: true, secrets: { elevenlabs: 'set' } });
    expect(secrets.store.get('elevenlabs')).toBe(FAKE);

    const g = await call(s.base, 'GET', '/api/settings');
    expect(g.json.secrets).toEqual({ elevenlabs: 'set' });

    const del = await call(s.base, 'DELETE', '/api/settings/secret/elevenlabs');
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true, secrets: { elevenlabs: 'unset' } });
    expect(secrets.store.has('elevenlabs')).toBe(false);
  });

  it('secret PUT rejects values that are too short, too long, have inner whitespace, or are not strings', async () => {
    const secrets = fakeSecrets();
    const s = await start({ dir: tmpDir(), secrets });
    const bad: unknown[] = [
      { value: 'short' },
      { value: 'x'.repeat(201) },
      { value: 'has space inside 123' },
      { value: 12345678901 },
      {},
    ];
    for (const b of bad) {
      const r = await call(s.base, 'PUT', '/api/settings/secret/elevenlabs', { body: b });
      expect(r.status, JSON.stringify(b).slice(0, 40)).toBe(400);
      expect(r.json.ok).toBe(false);
    }
    expect(secrets.store.size).toBe(0);
  });

  it('secret routes give 503 when no secrets admin is configured', async () => {
    const s = await start({ dir: tmpDir() });
    const put = await call(s.base, 'PUT', '/api/settings/secret/elevenlabs', { body: { value: FAKE } });
    expect(put.status).toBe(503);
    const del = await call(s.base, 'DELETE', '/api/settings/secret/elevenlabs');
    expect(del.status).toBe(503);
  });

  it('the secret value never appears in any response', async () => {
    const secrets = fakeSecrets();
    const s = await start({ dir: tmpDir(), secrets });
    const responses: Resp[] = [];
    responses.push(await call(s.base, 'PUT', '/api/settings/secret/elevenlabs', { body: { value: FAKE } }));
    responses.push(await call(s.base, 'GET', '/api/settings'));
    responses.push(await call(s.base, 'PUT', '/api/settings', { body: { language: 'en' } }));
    // malformed and invalid bodies that contain the value must not be echoed back
    responses.push(await call(s.base, 'PUT', '/api/settings/secret/elevenlabs', { raw: `{"value": "${FAKE}"` }));
    responses.push(await call(s.base, 'PUT', '/api/settings/secret/elevenlabs', { body: { value: `${FAKE} extra` } }));
    responses.push(await call(s.base, 'PUT', '/api/settings', { raw: `{"language": "${FAKE}"` }));
    responses.push(await call(s.base, 'PUT', '/api/settings', { body: { language: FAKE } }));
    responses.push(await call(s.base, 'PUT', '/api/settings', { body: { [FAKE]: 1 } }));
    responses.push(await call(s.base, 'DELETE', '/api/settings/secret/elevenlabs'));
    responses.push(await call(s.base, 'GET', '/api/settings/unknown'));
    for (const r of responses) {
      expect(r.text).not.toContain(FAKE);
      expect(JSON.stringify(r.json ?? {})).not.toContain(FAKE);
    }
  });

  it('origin not allowed gives 403 and CORS echoes an allowed origin', async () => {
    const s = await start({ dir: tmpDir() });
    const denied = await call(s.base, 'GET', '/api/settings', { origin: 'http://evil.example' });
    expect(denied.status).toBe(403);

    const allowed = await call(s.base, 'GET', '/api/settings', { origin: 'http://127.0.0.1:5173' });
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');

    const pre = await call(s.base, 'OPTIONS', '/api/settings', { origin: 'http://127.0.0.1:5173' });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toBe('GET, PUT, POST, DELETE');

    const preDenied = await call(s.base, 'OPTIONS', '/api/settings', { origin: 'http://evil.example' });
    expect(preDenied.status).toBe(403);
  });

  it('a config file with a bad field loads with defaults and a warning in GET', async () => {
    const dir = tmpDir();
    fs.writeFileSync(configFile(dir), JSON.stringify({ port: 'x', language: 'en' }), 'utf8');
    const s = await start({ dir });
    const r = await call(s.base, 'GET', '/api/settings');
    expect(r.json.config.language).toBe('en');
    expect(r.json.config.port).toBeNull();
    expect(r.json.warnings.join('\n')).toMatch(/port/);
  });
});

describe('SettingsApi and the app lock record', () => {
  // Fake verifier values. They are never a real hash of a real password.
  const REC: AppLockRecord = {
    v: 1,
    kdf: 'scrypt',
    N: 1024,
    r: 8,
    p: 1,
    salt: Buffer.alloc(16, 3).toString('base64'),
    hash: Buffer.alloc(32, 4).toString('base64'),
  };

  it('GET /api/settings never returns the appLock record', async () => {
    const dir = tmpDir();
    saveAppLock(dir, REC);
    const s = await start({ dir });
    const r = await call(s.base, 'GET', '/api/settings');
    expect(r.status).toBe(200);
    expect(r.json).not.toHaveProperty('appLock');
    expect(r.json.config).not.toHaveProperty('appLock');
    expect(r.text).not.toContain(REC.hash);
  });

  it('PUT /api/settings cannot set the appLock record', async () => {
    const dir = tmpDir();
    const s = await start({ dir });
    const r = await call(s.base, 'PUT', '/api/settings', { body: { appLock: REC } });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'unknown key' });
    expect(loadAppLock(dir)).toBeNull();
  });

  it('PUT /api/settings cannot clear the appLock record', async () => {
    const dir = tmpDir();
    saveAppLock(dir, REC);
    const s = await start({ dir });
    const r = await call(s.base, 'PUT', '/api/settings', { body: { appLock: null } });
    expect(r.status).toBe(400);
    expect(loadAppLock(dir)).toEqual(REC);
  });

  it('a normal PUT keeps the stored appLock record in config.json', async () => {
    const dir = tmpDir();
    saveAppLock(dir, REC);
    const s = await start({ dir });
    const r = await call(s.base, 'PUT', '/api/settings', { body: { language: 'en' } });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(REC.hash);
    expect(loadAppLock(dir)).toEqual(REC);
    expect(fs.readFileSync(configFile(dir), 'utf8')).toContain(REC.hash);
  });
});
