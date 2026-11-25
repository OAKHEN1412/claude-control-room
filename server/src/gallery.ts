// Video gallery: every finished render found in <root>/<project>/renders/*.mp4|mov|webm (top level only, so
// renders/parts/ and other sub-folders are skipped). The browser never sends a path: the server builds an
// index of what it found, hands out an id per file (hash of the path) and play / thumbnail / open-folder
// accept only an id from the current index. Thumbnails (one ffmpeg frame) and durations (ffprobe) are cached
// under the data dir, keyed by hash(path + size + mtime). ffmpeg/ffprobe run at most 2 at a time.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ClipJob, GalleryItem } from '../../shared/protocol';
import { dataDir } from './cmdlog';
import { OUR_STYLES, type OurStyle } from './ourStyles';
import { ffmpegArgs, type RunFfmpeg, runFfmpeg } from './stills';

export const VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Scan roots: CR_GALLERY_ROOTS (path-delimiter separated) or just ~/videos. Each root holds project folders. */
export function defaultGalleryRoots(): string[] {
  const o = process.env.CR_GALLERY_ROOTS;
  if (o && o.trim() !== '') return o.split(path.delimiter).map((s) => s.trim()).filter((s) => s !== '');
  return [path.join(os.homedir(), 'videos')];
}

export interface FoundFile {
  id: string;
  file: string;
  project: string;
  projectDir: string;
  name: string;
  size: number;
  mtimeMs: number;
}

function norm(p: string): string {
  return path.resolve(p).toLowerCase();
}

export function fileId(file: string): string {
  return createHash('sha256').update(norm(file)).digest('hex').slice(0, 16);
}

/** Cache key of the thumbnail / duration of one file: changes when the file is replaced or edited. */
export function galleryKey(f: Pick<FoundFile, 'file' | 'size' | 'mtimeMs'>): string {
  return createHash('sha256').update(`${norm(f.file)}\n${f.size}\n${Math.round(f.mtimeMs)}`).digest('hex').slice(0, 16);
}

/** Finds <root>/<project>/renders/<file>.mp4|mov|webm, top level of renders/ only. Async, never throws. */
export async function scanRoots(roots: string[]): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let projects: fs.Dirent[];
    try {
      projects = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(
      projects
        .filter((d) => d.isDirectory())
        .map(async (proj) => {
          const projectDir = path.join(root, proj.name);
          const rendersDir = path.join(projectDir, 'renders');
          let entries: fs.Dirent[];
          try {
            entries = await fs.promises.readdir(rendersDir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (!e.isFile()) continue; // sub-folders (parts/) and symlinks are skipped
            const ext = path.extname(e.name).toLowerCase();
            if (!(ext in VIDEO_TYPES)) continue;
            const file = path.join(rendersDir, e.name);
            try {
              const st = await fs.promises.stat(file);
              if (!st.isFile() || st.size <= 0) continue;
              const id = fileId(file);
              if (seen.has(id)) continue;
              seen.add(id);
              out.push({ id, file, project: proj.name, projectDir, name: path.basename(e.name, path.extname(e.name)), size: st.size, mtimeMs: Math.round(st.mtimeMs) });
            } catch {
              // vanished while scanning
            }
          }
        }),
    );
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
}

/** Parses a single-range header. 'none' = no/unsupported header (serve all), 'bad' = unsatisfiable (416). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'none' | 'bad' {
  if (!header) return 'none';
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'none';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return 'bad';
  return { start, end };
}

class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r)); // slot is handed over, see finally
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export type RunFfprobe = (file: string) => Promise<number | null>;

export const runFfprobe: RunFfprobe = (file) =>
  new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        const n = Number(String(stdout).trim());
        resolve(!err && Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null);
      },
    );
  });

export type OpenFolder = (file: string) => void;

/** explorer.exe /select,"<file>": the path comes from the index, never from the browser. */
export const openInExplorer: OpenFolder = (file) => {
  const child = spawn('explorer.exe', [`/select,"${file}"`], { windowsHide: false, detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  child.on('error', () => undefined);
  child.unref();
};

export interface GalleryDeps {
  roots?: () => string[];
  dir?: string; // cache dir (default <data dir>/gallery)
  ffmpeg?: RunFfmpeg;
  ffprobe?: RunFfprobe;
  openFolder?: OpenFolder;
  jobs?: () => ClipJob[];
  styles?: readonly OurStyle[];
  originAllowed: (origin: string | undefined) => boolean;
  concurrency?: number;
}

export class GalleryService {
  private index = new Map<string, FoundFile>();
  private readonly limiter: Limiter;
  private readonly durations = new Map<string, number | null>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly failedThumbs = new Set<string>();
  private readonly probing = new Map<string, Promise<number | null>>();
  private readonly deps: GalleryDeps;

  constructor(deps: GalleryDeps) {
    this.deps = deps;
    this.limiter = new Limiter(deps.concurrency ?? 2);
  }

  private dir(): string {
    return this.deps.dir ?? path.join(dataDir(), 'gallery');
  }

  /** The file behind an id of the current index, or null. */
  lookup(id: string): FoundFile | null {
    return this.index.get(id) ?? null;
  }

  duration(f: FoundFile): Promise<number | null> {
    const key = galleryKey(f);
    if (this.durations.has(key)) return Promise.resolve(this.durations.get(key) ?? null);
    let p = this.probing.get(key);
    if (!p) {
      p = this.probe(f, key).finally(() => this.probing.delete(key));
      this.probing.set(key, p);
    }
    return p;
  }

  private async probe(f: FoundFile, key: string): Promise<number | null> {
    const cache = path.join(this.dir(), `dur-${key}.json`);
    try {
      const j = JSON.parse(await fs.promises.readFile(cache, 'utf8')) as { durationSec?: unknown };
      if (typeof j.durationSec === 'number') {
        this.durations.set(key, j.durationSec);
        return j.durationSec;
      }
    } catch {
      // not cached
    }
    const d = await this.limiter.run(() => (this.deps.ffprobe ?? runFfprobe)(f.file));
    this.durations.set(key, d);
    if (d !== null) {
      try {
        await fs.promises.mkdir(this.dir(), { recursive: true });
        await fs.promises.writeFile(cache, JSON.stringify({ durationSec: d }));
      } catch {
        // cache is best effort
      }
    }
    return d;
  }

  /** Rescans the roots (cheap stat), replaces the index and returns the cards, newest first. */
  async list(): Promise<GalleryItem[]> {
    const found = await scanRoots((this.deps.roots ?? defaultGalleryRoots)());
    this.index = new Map(found.map((f) => [f.id, f]));
    const jobs = (this.deps.jobs?.() ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
    const styles = this.deps.styles ?? OUR_STYLES;
    return Promise.all(
      found.map(async (f) => {
        const job = jobs.filter((j) => norm(j.cwd) === norm(f.projectDir)).pop();
        const ours = styles.find((s) => s.renders.some((r) => norm(r) === norm(f.file)));
        return {
          id: f.id,
          project: f.project,
          name: f.name,
          title: `${f.project} / ${f.name}`,
          mtimeMs: f.mtimeMs,
          size: f.size,
          durationSec: await this.duration(f),
          style: job ? job.styleName : ours ? ours.name : '',
          topic: job ? job.topic : '',
          thumbUrl: `/api/gallery/thumb/${f.id}`,
          videoUrl: `/api/gallery/video/${f.id}`,
        };
      }),
    );
  }

  /** Cached thumbnail JPEG (cut first when missing), or null when ffmpeg failed. */
  thumb(f: FoundFile): Promise<string | null> {
    const key = galleryKey(f);
    const out = path.join(this.dir(), `thumb-${key}.jpg`);
    try {
      if (fs.statSync(out).size > 0) return Promise.resolve(out);
    } catch {
      // cut it below
    }
    if (this.failedThumbs.has(key)) return Promise.resolve(null); // do not respawn ffmpeg for a broken render on every refresh
    let p = this.inflight.get(key);
    if (!p) {
      p = this.cut(f, out)
        .then((r) => {
          if (!r) this.failedThumbs.add(key);
          return r;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async cut(f: FoundFile, out: string): Promise<string | null> {
    await fs.promises.mkdir(this.dir(), { recursive: true });
    const run = this.deps.ffmpeg ?? runFfmpeg;
    const tmp = `${out}.part.jpg`;
    for (const at of [5, 0]) {
      try {
        await this.limiter.run(() => run(ffmpegArgs(f.file, tmp, at)));
        if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
          fs.renameSync(tmp, out);
          return out;
        }
      } catch {
        // try the first frame next
      }
    }
    fs.rmSync(tmp, { force: true });
    return null;
  }

  private json(res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
    res.end(JSON.stringify(body));
  }

  private notFound(res: http.ServerResponse, cors: Record<string, string>): void {
    res.writeHead(404, cors);
    res.end();
  }

  /** Serves a file with Range support (video seeking). */
  private sendRanged(req: http.IncomingMessage, res: http.ServerResponse, file: string, type: string, cors: Record<string, string>, cache: string): void {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      this.notFound(res, cors);
      return;
    }
    const range = parseRange(req.headers.range, size);
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, ...cors };
    if (range === 'bad') {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    const part = range === 'none' ? null : range;
    const start = part ? part.start : 0;
    const end = part ? part.end : size - 1;
    res.writeHead(part ? 206 : 200, { ...base, 'Content-Length': end - start + 1, ...(part ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /** Returns true when the request was a /api/gallery route (handled). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/gallery' && !url.pathname.startsWith('/api/gallery/')) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!this.deps.originAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD, POST', 'Access-Control-Allow-Headers': 'Content-Type, Range' });
      res.end();
      return true;
    }
    void this.route(req, res, url.pathname, cors).catch(() => {
      if (!res.headersSent) this.json(res, 500, { ok: false, error: 'server error' }, cors);
      else res.destroy();
    });
    return true;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, p: string, cors: Record<string, string>): Promise<void> {
    const m = req.method;
    if (m === 'GET' && p === '/api/gallery') {
      this.json(res, 200, { ok: true, items: await this.list() }, cors);
      return;
    }
    const g = /^\/api\/gallery\/(thumb|video|open)\/([0-9a-f]{16})$/.exec(p);
    const f = g ? this.lookup(g[2]) : null;
    if (!g || !f) {
      this.notFound(res, cors);
      return;
    }
    if ((m === 'GET' || m === 'HEAD') && g[1] === 'thumb') {
      const t = await this.thumb(f);
      if (!t) this.notFound(res, cors);
      else this.sendRanged(req, res, t, 'image/jpeg', cors, 'private, max-age=3600');
      return;
    }
    if ((m === 'GET' || m === 'HEAD') && g[1] === 'video') {
      this.sendRanged(req, res, f.file, VIDEO_TYPES[path.extname(f.file).toLowerCase()] ?? 'application/octet-stream', cors, 'no-cache');
      return;
    }
    if (m === 'POST' && g[1] === 'open') {
      try {
        (this.deps.openFolder ?? openInExplorer)(f.file);
        this.json(res, 200, { ok: true }, cors);
      } catch {
        this.json(res, 500, { ok: false, error: 'เปิดโฟลเดอร์ไม่ได้', code: 'srv.gallery.openFailed' }, cors);
      }
      return;
    }
    this.notFound(res, cors);
  }
}
