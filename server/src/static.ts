// Production mode: serve the built web (web/dist) from the same port as the API. GET/HEAD only.
// Real files are served as-is; any other path without a file extension (/, /clip) gets index.html (SPA fallback).
// A path that looks like a file but does not exist is a plain 404, so a missing asset never turns into HTML.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolves a URL path to a file under root, or null when it escapes root. */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const abs = path.resolve(root, '.' + path.posix.normalize('/' + decoded.split('\\').join('/')));
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Handles the request when it is a static one. Returns false for non-GET/HEAD so the caller can 404. */
export function serveStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const abs = resolveStatic(root, url.pathname);
  if (!abs) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad path');
    return true;
  }
  let file = abs;
  if (!isFile(file)) {
    if (path.extname(url.pathname) !== '') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return true;
    }
    file = path.join(root, 'index.html');
    if (!isFile(file)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('web/dist not built: run npm run build');
      return true;
    }
  }
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}
