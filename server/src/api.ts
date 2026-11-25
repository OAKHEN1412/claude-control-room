// HTTP API for Clip Studio (JSON + images + audio). Loopback only; browser Origin must be loopback (CORS is
// answered only for those). No secret ever passes through here: the ElevenLabs key stays inside VoiceService.
import fs from 'node:fs';
import type http from 'node:http';
import { CLIP_VOICE_MODEL } from '../../shared/protocol';
import { codeOf } from './codedError';
import { OUR_STYLES } from './ourStyles';
import { ensureStill, type RunFfmpeg } from './stills';
import { lemoThumbFile, lemoView, loadLemoStyles, type LemoList } from './styles';
import { DEFAULT_SAMPLE, VoiceError, type VoiceService } from './voice';

export interface ApiDeps {
  voice?: VoiceService;
  lemoFile?: string;
  stillsDir?: string;
  ffmpeg?: RunFfmpeg;
  originAllowed: (origin: string | undefined) => boolean;
}

export class ClipApi {
  private lemo: LemoList;
  private readonly deps: ApiDeps;

  constructor(deps: ApiDeps) {
    this.deps = deps;
    this.lemo = loadLemoStyles(deps.lemoFile);
  }

  lemoList(): LemoList {
    return this.lemo;
  }

  reloadLemo(): LemoList {
    this.lemo = loadLemoStyles(this.deps.lemoFile);
    return this.lemo;
  }

  private json(res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
    res.end(JSON.stringify(body));
  }

  private sendFile(res: http.ServerResponse, file: string, type: string, cors: Record<string, string>, req: http.IncomingMessage): void {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      res.writeHead(404, cors);
      res.end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && type === 'audio/mpeg') {
      const start = range[1] === '' ? 0 : Number(range[1]);
      const end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start <= end && start < size) {
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...cors });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', ...cors });
    fs.createReadStream(file).pipe(res);
  }

  private body(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > 8 * 1024) {
          reject(new VoiceError('คำขอใหญ่เกินไป', 'srv.api.bodyTooLarge'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new VoiceError('JSON ไม่ถูกต้อง', 'srv.api.badJson'));
        }
      });
      req.on('error', reject);
    });
  }

  /** Returns true when the request was an /api/ route (handled). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!this.deps.originAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return true;
    }
    void this.route(req, res, url, cors).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      this.json(res, e instanceof VoiceError ? 400 : 500, { ok: false, error: e instanceof VoiceError ? msg : 'server error', ...(e instanceof VoiceError ? codeOf(e) : {}) }, cors);
    });
    return true;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, cors: Record<string, string>): Promise<void> {
    const p = url.pathname;
    const m = req.method;
    if (m === 'GET' && p === '/api/clip-config') {
      this.json(res, 200, {
        ours: OUR_STYLES.map((s) => ({ id: s.id, name: s.name, note: s.note, alt: s.alt, stillUrl: `/api/still/${s.id}` })),
        lemo: lemoView(this.lemo),
        voices: this.deps.voice?.list() ?? [],
        voiceModel: CLIP_VOICE_MODEL,
        defaultSample: DEFAULT_SAMPLE,
      }, cors);
      return;
    }
    if (m === 'POST' && p === '/api/styles/reload') {
      this.json(res, 200, { ok: true, lemo: lemoView(this.reloadLemo()) }, cors);
      return;
    }
    let g: RegExpExecArray | null;
    if (m === 'GET' && (g = /^\/api\/still\/([a-z0-9]+)$/.exec(p))) {
      const style = OUR_STYLES.find((s) => s.id === g![1]);
      const r = style ? await ensureStill(style, { dir: this.deps.stillsDir, ffmpeg: this.deps.ffmpeg }) : { file: null };
      if (!r.file) {
        res.writeHead(404, cors);
        res.end();
        return;
      }
      this.sendFile(res, r.file, 'image/jpeg', cors, req);
      return;
    }
    if (m === 'GET' && (g = /^\/api\/lemo-thumb\/([A-Za-z0-9._-]+)$/.exec(p))) {
      const file = lemoThumbFile(this.lemo.styles.find((s) => s.id === g![1]));
      if (!file) {
        res.writeHead(404, cors);
        res.end();
        return;
      }
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      this.sendFile(res, file, ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg', cors, req);
      return;
    }
    const voice = this.deps.voice;
    if (!voice) {
      this.json(res, 503, { ok: false, error: 'ระบบเสียงยังไม่เปิดใช้', code: 'srv.voice.disabled' }, cors);
      return;
    }
    if (m === 'POST' && p === '/api/voices') {
      const b = (await this.body(req)) as { id?: unknown; name?: unknown };
      voice.add(String(b.id ?? '').trim(), typeof b.name === 'string' ? b.name : '');
      this.json(res, 200, { ok: true, voices: voice.list() }, cors);
      return;
    }
    if (m === 'DELETE' && (g = /^\/api\/voices\/([A-Za-z0-9]+)$/.exec(p))) {
      this.json(res, 200, { ok: voice.remove(g[1]), voices: voice.list() }, cors);
      return;
    }
    if (m === 'POST' && p === '/api/voice/preview') {
      const b = (await this.body(req)) as { voiceId?: unknown; text?: unknown };
      const r = await voice.preview(String(b.voiceId ?? ''), String(b.text ?? ''));
      this.json(res, 200, { ok: true, cached: r.cached, url: `/api/voice/audio/${r.hash}` }, cors);
      return;
    }
    if (m === 'GET' && (g = /^\/api\/voice\/audio\/([0-9a-f]{64})$/.exec(p))) {
      const f = voice.audioFile(g[1]);
      if (!f) {
        res.writeHead(404, cors);
        res.end();
        return;
      }
      this.sendFile(res, f, 'audio/mpeg', cors, req);
      return;
    }
    res.writeHead(404, cors);
    res.end();
  }
}
