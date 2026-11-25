// POST /api/upload: raw body = the file, headers X-File-Name (URI-encoded) and Content-Type.
// Same origin rule as the other API routes. Answers {ok:true, id, name, mime, size}; the saved path never leaves the server.
import type http from 'node:http';
import { UPLOAD_MAX_BYTES } from '../../shared/uploads';
import type { UploadStore } from './uploads';

const ROUTE = '/api/upload';
export const UPLOAD_TOO_BIG = 'ไฟล์ใหญ่เกิน 25 MB';

export interface UploadApiDeps {
  store: UploadStore;
  originAllowed: (origin: string | undefined) => boolean;
  maxBytes?: number;
}

export class UploadApi {
  private readonly max: number;

  constructor(private readonly deps: UploadApiDeps) {
    this.max = deps.maxBytes ?? UPLOAD_MAX_BYTES;
  }

  /** Returns true when the request was the /api/upload route (handled). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== ROUTE) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!this.deps.originAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, X-File-Name' });
      res.end();
      return true;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...cors, Allow: 'POST, OPTIONS' });
      res.end();
      return true;
    }
    this.receive(req, res, cors);
    return true;
  }

  private json(res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>, close = false): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(close ? { Connection: 'close' } : {}), ...cors });
    res.end(JSON.stringify(body));
  }

  private receive(req: http.IncomingMessage, res: http.ServerResponse, cors: Record<string, string>): void {
    let name = 'file';
    try {
      const h = req.headers['x-file-name'];
      if (typeof h === 'string' && h !== '') name = decodeURIComponent(h);
    } catch {
      // keep the default name
    }
    const mime = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'application/octet-stream';
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > this.max) {
      this.json(res, 413, { ok: false, error: UPLOAD_TOO_BIG, code: 'srv.upload.tooBig' }, cors, true);
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      n += c.length;
      if (n > this.max) {
        over = true;
        chunks.length = 0;
        this.json(res, 413, { ok: false, error: UPLOAD_TOO_BIG, code: 'srv.upload.tooBig' }, cors, true);
        return; // the rest of the body is discarded as it arrives
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      if (n === 0) {
        this.json(res, 400, { ok: false, error: 'ไฟล์ว่างเปล่า', code: 'srv.upload.empty' }, cors);
        return;
      }
      try {
        const rec = this.deps.store.save(name, mime, Buffer.concat(chunks));
        this.json(res, 200, { ok: true, ...rec }, cors);
      } catch {
        this.json(res, 500, { ok: false, error: 'บันทึกไฟล์ไม่สำเร็จ', code: 'srv.upload.saveFailed' }, cors);
      }
    });
    req.on('error', () => {
      if (!res.headersSent) this.json(res, 400, { ok: false, error: 'อัปโหลดไม่สำเร็จ', code: 'srv.upload.failed' }, cors);
    });
  }
}
