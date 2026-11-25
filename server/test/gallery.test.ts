import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClipJob } from '../../shared/protocol';
import { defaultGalleryRoots, fileId, GalleryService, galleryKey, type FoundFile, type OpenFolder, parseRange, type RunFfprobe, scanRoots } from '../src/gallery';
import type { OurStyle } from '../src/ourStyles';
import type { RunFfmpeg } from '../src/stills';

it('the default gallery root is only ~/videos (CR_GALLERY_ROOTS still overrides it)', () => {
  const saved = process.env.CR_GALLERY_ROOTS;
  delete process.env.CR_GALLERY_ROOTS;
  try {
    expect(defaultGalleryRoots()).toEqual([path.join(os.homedir(), 'videos')]);
    process.env.CR_GALLERY_ROOTS = 'D:/a' + path.delimiter + 'E:/b';
    expect(defaultGalleryRoots()).toEqual(['D:/a', 'E:/b']);
  } finally {
    if (saved === undefined) delete process.env.CR_GALLERY_ROOTS;
    else process.env.CR_GALLERY_ROOTS = saved;
  }
});

// ---- helpers -------------------------------------------------------------------------------

const tracked: string[] = [];
const servers: http.Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of tracked) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tracked.push(d);
  return d;
}

function write(root: string, rel: string, data: string | Buffer = 'x'): string {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return f;
}

function setMtime(file: string, sec: number): void {
  fs.utimesSync(file, sec, sec);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 1000 bytes, byte i = i % 256. */
const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

/** Fake ffmpeg: writes a tiny JPEG-ish payload to the output path (always the last argument). */
const fakeFfmpeg: RunFfmpeg = async (args) => {
  fs.writeFileSync(args[args.length - 1], Buffer.from('JPEGDATA'));
};

const allowLoopback = (o: string | undefined) => o === undefined || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);

interface SvcOpts {
  roots: string[];
  dir: string;
  ffmpeg?: RunFfmpeg;
  ffprobe?: RunFfprobe;
  openFolder?: OpenFolder;
  jobs?: () => ClipJob[];
  styles?: readonly OurStyle[];
  concurrency?: number;
}

/** Every fake is set explicitly so the real ffmpeg / ffprobe / explorer are never reached. */
function makeService(o: SvcOpts): GalleryService {
  return new GalleryService({
    roots: () => o.roots,
    dir: o.dir,
    ffmpeg: o.ffmpeg ?? fakeFfmpeg,
    ffprobe: o.ffprobe ?? (async () => 12.5),
    openFolder: o.openFolder ?? (() => undefined),
    jobs: o.jobs,
    styles: o.styles ?? [],
    originAllowed: allowLoopback,
    concurrency: o.concurrency,
  });
}

async function serve(svc: GalleryService): Promise<number> {
  const server = http.createServer((req, res) => {
    if (!svc.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as net.AddressInfo).port;
}

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function call(port: number, method: string, p: string, headers: Record<string, string> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Standard fixture used by the scanner and HTTP tests. */
function scanFixture(): { root: string; files: Record<string, string> } {
  const root = tmp('cr-gallery-scan-');
  const x = write(root, 'a/renders/x.mp4', 'xx');
  const y = write(root, 'a/renders/y.MOV', 'yy');
  write(root, 'a/renders/z.txt', 'zz');
  write(root, 'a/renders/parts/p.mp4', 'pp');
  const w = write(root, 'b/renders/w.webm', 'ww');
  write(root, 'c/no-renders/q.mp4', 'qq');
  write(root, 'b/renders/empty.mp4', '');
  setMtime(x, 1_700_000_000 - 100);
  setMtime(y, 1_700_000_000 - 50);
  setMtime(w, 1_700_000_000 - 10);
  return { root, files: { x, y, w } };
}

// ---- 1. scanner ----------------------------------------------------------------------------

describe('scanRoots', () => {
  it('finds only top-level video files in renders/, newest first', async () => {
    const { root, files } = scanFixture();
    const found = await scanRoots([root]);
    expect(found.map((f) => f.file)).toEqual([files.w, files.y, files.x]);
    expect(found.map((f) => f.name)).toEqual(['w', 'y', 'x']);
    expect(found.map((f) => f.project)).toEqual(['b', 'a', 'a']);
    expect(found[1].projectDir).toBe(path.join(root, 'a'));
    expect(found[0].size).toBe(2);
    expect(found[0].id).toBe(fileId(files.w));
  });

  it('a missing root is skipped without throwing', async () => {
    const { root } = scanFixture();
    const missing = path.join(tmp('cr-gallery-missing-'), 'does-not-exist');
    await expect(scanRoots([missing])).resolves.toEqual([]);
    const both = await scanRoots([missing, root]);
    expect(both).toHaveLength(3);
  });
});

// ---- 2. id lookup and HTTP surface ---------------------------------------------------------

describe('id lookup and HTTP routes', () => {
  it('lookup returns the listed file and null for unknown ids', async () => {
    const { root, files } = scanFixture();
    const cache = tmp('cr-gallery-cache-');
    const svc = makeService({ roots: [root], dir: cache });
    const items = await svc.list();
    const id = fileId(files.x);
    expect(items.find((i) => i.id === id)).toBeDefined();
    expect(svc.lookup(id)?.file).toBe(files.x);
    expect(svc.lookup('0000000000000000')).toBeNull();
    expect(svc.lookup('not-an-id')).toBeNull();
    expect(svc.lookup('')).toBeNull();
  });

  it('a fresh service (no list yet) answers a valid-looking id with 404', async () => {
    const { root, files } = scanFixture();
    const svc = makeService({ roots: [root], dir: tmp('cr-gallery-cache-') });
    const port = await serve(svc);
    const r = await call(port, 'GET', `/api/gallery/video/${fileId(files.x)}`);
    expect(r.status).toBe(404);
  });

  it('GET /api/gallery lists items with thumb/video urls and never leaks a file path', async () => {
    const { root } = scanFixture();
    const svc = makeService({ roots: [root], dir: tmp('cr-gallery-cache-') });
    const port = await serve(svc);
    const r = await call(port, 'GET', '/api/gallery');
    expect(r.status).toBe(200);
    const text = r.body.toString('utf8');
    expect(text).not.toContain(root);
    expect(text).not.toContain(JSON.stringify(root).slice(1, -1));
    const j = JSON.parse(text) as { ok: boolean; items: Array<Record<string, unknown>> };
    expect(j.ok).toBe(true);
    expect(j.items).toHaveLength(3);
    for (const it of j.items) {
      expect(it.thumbUrl).toBe(`/api/gallery/thumb/${it.id}`);
      expect(it.videoUrl).toBe(`/api/gallery/video/${it.id}`);
      expect(Object.keys(it)).not.toContain('file');
      expect(Object.keys(it)).not.toContain('projectDir');
    }
  });

  it('unknown and traversal ids on video are 404', async () => {
    const { root } = scanFixture();
    const svc = makeService({ roots: [root], dir: tmp('cr-gallery-cache-') });
    const port = await serve(svc);
    await svc.list();
    expect((await call(port, 'GET', '/api/gallery/video/0123456789abcdef')).status).toBe(404);
    expect((await call(port, 'GET', '/api/gallery/video/..%2f..%2fetc')).status).toBe(404);
  });

  it('POST open: unknown id is 404 and openFolder is not called; valid id calls it once with the real path', async () => {
    const { root, files } = scanFixture();
    const calls: string[] = [];
    const svc = makeService({ roots: [root], dir: tmp('cr-gallery-cache-'), openFolder: (f) => calls.push(f) });
    const port = await serve(svc);
    await svc.list();
    expect((await call(port, 'POST', '/api/gallery/open/0123456789abcdef')).status).toBe(404);
    expect(calls).toHaveLength(0);
    const ok = await call(port, 'POST', `/api/gallery/open/${fileId(files.x)}`);
    expect(ok.status).toBe(200);
    expect(calls).toEqual([files.x]);
  });

  it('a request from a foreign Origin gets 403', async () => {
    const { root } = scanFixture();
    const svc = makeService({ roots: [root], dir: tmp('cr-gallery-cache-') });
    const port = await serve(svc);
    const r = await call(port, 'GET', '/api/gallery', { Origin: 'http://evil.example' });
    expect(r.status).toBe(403);
  });
});

// ---- 3. Range ------------------------------------------------------------------------------

describe('parseRange', () => {
  it('parses the supported forms and rejects the unsatisfiable ones', () => {
    expect(parseRange(undefined, 1000)).toBe('none');
    expect(parseRange('', 1000)).toBe('none');
    expect(parseRange('bytes=-', 1000)).toBe('none');
    expect(parseRange('items=0-1', 1000)).toBe('none');
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=500-5000', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=5000-', 1000)).toBe('bad');
    expect(parseRange('bytes=-0', 1000)).toBe('bad');
    expect(parseRange('bytes=50-10', 1000)).toBe('bad');
  });
});

describe('video route Range handling', () => {
  async function setup() {
    const root = tmp('cr-gallery-range-');
    write(root, 'p/renders/v.mp4', BYTES);
    const svc = makeService({ roots: [root], dir: tmp('cr-gallery-cache-') });
    const port = await serve(svc);
    const [item] = await svc.list();
    return { port, url: `/api/gallery/video/${item.id}` };
  }

  it('bytes=0-99 -> 206 with the first 100 bytes', async () => {
    const { port, url } = await setup();
    const r = await call(port, 'GET', url, { Range: 'bytes=0-99' });
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 0-99/1000');
    expect(r.headers['content-length']).toBe('100');
    expect(r.body.equals(BYTES.subarray(0, 100))).toBe(true);
  });

  it('bytes=900- and bytes=-100 -> the last 100 bytes', async () => {
    const { port, url } = await setup();
    const a = await call(port, 'GET', url, { Range: 'bytes=900-' });
    expect(a.status).toBe(206);
    expect(a.headers['content-range']).toBe('bytes 900-999/1000');
    expect(a.body.equals(BYTES.subarray(900))).toBe(true);
    const b = await call(port, 'GET', url, { Range: 'bytes=-100' });
    expect(b.status).toBe(206);
    expect(b.headers['content-range']).toBe('bytes 900-999/1000');
  });

  it('bytes=500-5000 clamps the end to 999', async () => {
    const { port, url } = await setup();
    const r = await call(port, 'GET', url, { Range: 'bytes=500-5000' });
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 500-999/1000');
    expect(r.body.length).toBe(500);
  });

  it('no Range header -> 200 with the full body and Accept-Ranges', async () => {
    const { port, url } = await setup();
    const r = await call(port, 'GET', url);
    expect(r.status).toBe(200);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.body.equals(BYTES)).toBe(true);
  });

  it('bytes=5000- -> 416 with Content-Range bytes */1000', async () => {
    const { port, url } = await setup();
    const r = await call(port, 'GET', url, { Range: 'bytes=5000-' });
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */1000');
  });

  it('HEAD returns 200 headers and no body', async () => {
    const { port, url } = await setup();
    const r = await call(port, 'HEAD', url);
    expect(r.status).toBe(200);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.body.length).toBe(0);
  });
});

// ---- 4. caching, thumbnails, concurrency ---------------------------------------------------

describe('galleryKey', () => {
  it('is stable for the same file/size/mtime and changes with size, mtime or path', () => {
    const base = { file: path.join('C:', 'x', 'a.mp4'), size: 100, mtimeMs: 1000.4 };
    expect(galleryKey(base)).toBe(galleryKey({ ...base }));
    expect(galleryKey(base)).not.toBe(galleryKey({ ...base, size: 101 }));
    expect(galleryKey(base)).not.toBe(galleryKey({ ...base, mtimeMs: 2000 }));
    expect(galleryKey(base)).not.toBe(galleryKey({ ...base, file: path.join('C:', 'x', 'b.mp4') }));
  });
});

describe('duration cache', () => {
  it('ffprobe runs once per file in memory, zero times for a new service on the same cache dir, and again after the file changes', async () => {
    const root = tmp('cr-gallery-dur-');
    const a = write(root, 'p1/renders/a.mp4', 'aaaa');
    write(root, 'p2/renders/b.mp4', 'bbbb');
    const cache = tmp('cr-gallery-cache-');
    let probes = 0;
    const ffprobe: RunFfprobe = async () => {
      probes++;
      return 7.5;
    };

    const svc = makeService({ roots: [root], dir: cache, ffprobe });
    const first = await svc.list();
    expect(probes).toBe(2);
    await svc.list();
    expect(probes).toBe(2);
    expect(first.every((i) => i.durationSec === 7.5)).toBe(true);

    const fresh = makeService({ roots: [root], dir: cache, ffprobe });
    const again = await fresh.list();
    expect(probes).toBe(2);
    expect(again.every((i) => i.durationSec === 7.5)).toBe(true);
    expect(fs.readdirSync(cache).filter((n) => n.startsWith('dur-') && n.endsWith('.json'))).toHaveLength(2);

    fs.writeFileSync(a, 'a much longer payload than before');
    const changed = makeService({ roots: [root], dir: cache, ffprobe });
    await changed.list();
    expect(probes).toBe(3);
  });
});

describe('thumbnails', () => {
  it('thumb() cuts once, caches as thumb-<key>.jpg, and the HTTP route serves image/jpeg', async () => {
    const root = tmp('cr-gallery-thumb-');
    const f = write(root, 'p/renders/t.mp4', 'tttt');
    const cache = tmp('cr-gallery-cache-');
    let ffCalls = 0;
    const ffmpeg: RunFfmpeg = async (args) => {
      ffCalls++;
      fs.writeFileSync(args[args.length - 1], Buffer.from('JPEGDATA'));
    };
    const svc = makeService({ roots: [root], dir: cache, ffmpeg });
    const [item] = await svc.list();
    const ff = svc.lookup(item.id) as FoundFile;
    expect(ff.file).toBe(f);

    const p1 = await svc.thumb(ff);
    const p2 = await svc.thumb(ff);
    expect(ffCalls).toBe(1);
    expect(p1).toBe(p2);
    expect(p1).toBe(path.join(cache, `thumb-${galleryKey(ff)}.jpg`));
    expect(fs.existsSync(p1 as string)).toBe(true);

    const port = await serve(svc);
    const r = await call(port, 'GET', `/api/gallery/thumb/${item.id}`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('image/jpeg');
    expect(r.body.toString()).toBe('JPEGDATA');
    expect(ffCalls).toBe(1);
  });

  it('when ffmpeg always fails: thumb() resolves null, the route is 404, and no .part.jpg is left behind', async () => {
    const root = tmp('cr-gallery-thumbfail-');
    write(root, 'p/renders/t.mp4', 'tttt');
    const cache = tmp('cr-gallery-cache-');
    let ffCalls = 0;
    const ffmpeg: RunFfmpeg = async () => {
      ffCalls++;
      throw new Error('fake ffmpeg failure');
    };
    const svc = makeService({ roots: [root], dir: cache, ffmpeg });
    const [item] = await svc.list();
    const ff = svc.lookup(item.id) as FoundFile;
    await expect(svc.thumb(ff)).resolves.toBeNull();
    expect(ffCalls).toBe(2); // tried 5 s in, then the first frame

    const port = await serve(svc);
    const r = await call(port, 'GET', `/api/gallery/thumb/${item.id}`);
    expect(r.status).toBe(404);
    const leftovers = fs.readdirSync(cache).filter((n) => n.endsWith('.part.jpg') || n.startsWith('thumb-'));
    expect(leftovers).toEqual([]);
  });
});

describe('ffprobe concurrency', () => {
  it('never runs more than 2 probes at once for 6 files', async () => {
    const root = tmp('cr-gallery-conc-');
    for (let i = 1; i <= 6; i++) write(root, `p${i}/renders/v.mp4`, `v${i}`);
    let running = 0;
    let max = 0;
    let total = 0;
    const ffprobe: RunFfprobe = async () => {
      running++;
      total++;
      max = Math.max(max, running);
      await sleep(20);
      running--;
      return 3;
    };
    const svc = makeService({ roots: [root], dir: tmp('cr-gallery-cache-'), ffprobe });
    const items = await svc.list();
    expect(items).toHaveLength(6);
    expect(total).toBe(6);
    expect(max).toBeLessThanOrEqual(2);
    expect(max).toBeGreaterThanOrEqual(1);
  });
});

// ---- 5. style / topic join -----------------------------------------------------------------

describe('style and topic join', () => {
  it('items from a project whose cwd matches a clip job get the job styleName and topic', async () => {
    const root = tmp('cr-gallery-job-');
    write(root, 'a/renders/x.mp4', 'xx');
    write(root, 'b/renders/w.webm', 'ww');
    const projA = path.join(root, 'a');
    const job = { cwd: projA, styleName: 'Ember', topic: 'Pipes', createdAt: 1 } as unknown as ClipJob;
    const svc = makeService({ roots: [root], dir: tmp('cr-gallery-cache-'), jobs: () => [job] });
    const items = await svc.list();
    const a = items.find((i) => i.project === 'a');
    const b = items.find((i) => i.project === 'b');
    expect(a?.style).toBe('Ember');
    expect(a?.topic).toBe('Pipes');
    expect(b?.style).toBe('');
    expect(b?.topic).toBe('');
  });

  it('an OurStyle whose renders list contains a file gives that file its style name', async () => {
    const root = tmp('cr-gallery-ours-');
    write(root, 'a/renders/x.mp4', 'xx');
    const w = write(root, 'b/renders/w.webm', 'ww');
    const style = { id: 's1', name: 'Lumen', note: '', sourceDir: '', workflowFiles: [], extraRules: [], renders: [w], alt: '' } as unknown as OurStyle;
    const svc = makeService({ roots: [root], dir: tmp('cr-gallery-cache-'), styles: [style] });
    const items = await svc.list();
    expect(items.find((i) => i.project === 'b')?.style).toBe('Lumen');
    expect(items.find((i) => i.project === 'a')?.style).toBe('');
    expect(items.find((i) => i.project === 'a')?.topic).toBe('');
  });
});
