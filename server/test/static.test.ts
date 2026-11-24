import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { portInUse } from '../src/index';
import { resolveStatic, serveStatic } from '../src/static';

let dir: string;
let srv: http.Server;
let port: number;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-static-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>spa</html>');
  fs.writeFileSync(path.join(dir, 'assets', 'a.js'), 'console.log(1)');
  fs.writeFileSync(path.join(path.dirname(dir), 'cr-secret.txt'), 'secret');
  srv = http.createServer((req, res) => {
    if (!serveStatic(dir, req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  port = (srv.address() as net.AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(dir), 'cr-secret.txt'), { force: true });
});

const get = (p: string, method = 'GET') =>
  new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
    }).on('error', reject).end();
  });

describe('static serving', () => {
  it('serves index.html at / and falls back to it for SPA routes', async () => {
    expect((await get('/')).body).toContain('spa');
    const clip = await get('/clip');
    expect(clip.status).toBe(200);
    expect(clip.body).toContain('spa');
    expect(clip.type).toContain('text/html');
  });
  it('serves real files with their type', async () => {
    const js = await get('/assets/a.js');
    expect(js.status).toBe(200);
    expect(js.type).toContain('javascript');
    expect(js.body).toBe('console.log(1)');
  });
  it('a missing file with an extension is 404, never index.html', async () => {
    expect((await get('/assets/missing.js')).status).toBe(404);
  });
  it('refuses paths that climb out of the root', async () => {
    for (const u of ['/../cr-secret.txt', '/..%2f..%2fcr-secret.txt', '/%2e%2e/cr-secret.txt', '/..\cr-secret.txt']) {
      const r = resolveStatic(dir, u);
      expect(r === null || r.startsWith(dir + path.sep)).toBe(true);
    }
    expect((await get('/..%2fcr-secret.txt')).body).not.toContain('secret');
    expect((await get('/%2e%2e/cr-secret.txt')).body).not.toContain('secret');
  });
  it('POST is not handled', async () => {
    expect((await get('/', 'POST')).status).toBe(404);
  });
});

describe('port guard', () => {
  it('portInUse is true for a listening port and false once it is free', async () => {
    expect(await portInUse(port)).toBe(true);
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const p = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    expect(await portInUse(p)).toBe(false);
  });
});
