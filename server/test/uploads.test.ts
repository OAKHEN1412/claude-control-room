import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INLINE_IMAGE_MAX_BYTES, attachDisplayName, sanitizeFileName, showAttachments } from '../../shared/uploads';
import { buildUserContent, sniffImageMime } from '../src/attachments';
import { parseClientMsg } from '../src/commands';
import { createState, derive, ingestLine } from '../src/parser';
import { CommandError, Runner, type ChildLike } from '../src/runner';
import { UploadApi } from '../src/uploadApi';
import { UploadStore, localDay, type StoredUpload } from '../src/uploads';

// 1x1 red PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('sanitizeFileName', () => {
  it('drops folders, control characters and forbidden characters, keeps Thai', () => {
    expect(sanitizeFileName('C:\\Users\\x\\..\\secret.txt')).toBe('secret.txt');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.png')).toBe('a_b_c_d_e_f_g_h.png');
    expect(sanitizeFileName('line\nbreak\u0000.txt')).toBe('line_break_.txt');
    expect(sanitizeFileName('ใบเสนอราคา ลูกค้า.pdf')).toBe('ใบเสนอราคา ลูกค้า.pdf');
  });
  it('avoids reserved Windows names, trailing dots/spaces and empty names', () => {
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFileName('nul')).toBe('_nul');
    expect(sanitizeFileName('com1.log')).toBe('_com1.log');
    expect(sanitizeFileName('report. . ')).toBe('report');
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('...')).toBe('file');
    expect(sanitizeFileName('   ')).toBe('file');
  });
  it('caps the length and keeps the extension', () => {
    const n = sanitizeFileName(`${'ก'.repeat(300)}.pdf`);
    expect(n.length).toBeLessThanOrEqual(100);
    expect(n.endsWith('.pdf')).toBe(true);
  });
});

describe('attachment display', () => {
  it('shows the name without the uuid prefix', () => {
    const p = 'C:\\Users\\x\\uploads\\2026-11-24\\3f2b8c1a-1111-4222-8333-444444444444-shot.png';
    expect(attachDisplayName(p)).toBe('shot.png');
    expect(showAttachments(`ดูรูปนี้\n[ไฟล์แนบ] ${p}`)).toBe('ดูรูปนี้\n📎 shot.png');
    expect(showAttachments('plain')).toBe('plain');
  });
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-upl-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('UploadStore', () => {
  it('saves under uploads/<day>/<uuid>-<name> and resolves the id', () => {
    const now = Date.parse('2026-11-24T10:00:00');
    const store = new UploadStore(path.join(tmp, 'uploads'), () => now);
    const rec = store.save('../evil/shot.png', 'image/png; charset=x', PNG);
    expect(rec.id).toMatch(UUID);
    expect(rec).toMatchObject({ name: 'shot.png', mime: 'image/png', size: PNG.length });
    expect('path' in rec).toBe(false);
    const got = store.resolve(rec.id)!;
    expect(got.path).toBe(path.join(tmp, 'uploads', '2026-11-24', `${rec.id}-shot.png`));
    expect(fs.readFileSync(got.path).equals(PNG)).toBe(true);
  });
  it('refuses ids that are not uuids or are unknown, and finds files again after a restart', () => {
    const store = new UploadStore(path.join(tmp, 'uploads'));
    const rec = store.save('a.txt', 'text/plain', Buffer.from('hi'));
    expect(store.resolve('../../etc/passwd')).toBeNull();
    expect(store.resolve('x')).toBeNull();
    expect(store.resolve('00000000-0000-4000-8000-000000000000')).toBeNull();
    const fresh = new UploadStore(path.join(tmp, 'uploads'));
    const again = fresh.resolve(rec.id)!;
    expect(again.name).toBe('a.txt');
    expect(again.size).toBe(2);
  });
  it('resolve is null once the file is gone', () => {
    const store = new UploadStore(path.join(tmp, 'uploads'));
    const rec = store.save('a.txt', 'text/plain', Buffer.from('hi'));
    fs.rmSync(store.resolve(rec.id)!.path);
    expect(store.resolve(rec.id)).toBeNull();
  });
  it('cleanup removes day folders older than 14 days only', () => {
    const now = Date.parse('2026-11-24T12:00:00');
    const root = path.join(tmp, 'uploads');
    for (const d of ['2026-11-01', '2026-11-09', '2026-11-10', '2026-11-24', 'notes']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const removed = new UploadStore(root, () => now).cleanup();
    expect(removed.sort()).toEqual(['2026-11-01', '2026-11-09']);
    expect(fs.readdirSync(root).sort()).toEqual(['2026-11-10', '2026-11-24', 'notes']);
    expect(localDay(now)).toBe('2026-11-24');
  });
});

describe('POST /api/upload', () => {
  let server: http.Server;
  let port = 0;
  let store: UploadStore;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-upl-api-'));
    store = new UploadStore(path.join(dir, 'uploads'));
    const api = new UploadApi({ store, maxBytes: 1000, originAllowed: (o) => o === undefined || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o) });
    server = http.createServer((req, res) => {
      if (!api.handle(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = (body: Buffer | string, headers: Record<string, string> = {}, method = 'POST') =>
    fetch(`http://127.0.0.1:${port}/api/upload`, { method, body: method === 'POST' ? (typeof body === 'string' ? body : new Uint8Array(body)) : undefined, headers });

  it('stores the file and answers id, name, mime, size', async () => {
    const r = await post(PNG, { 'X-File-Name': encodeURIComponent('รูป หน้าจอ.png'), 'Content-Type': 'image/png' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ ok: true, name: 'รูป หน้าจอ.png', mime: 'image/png', size: PNG.length });
    expect(j.path).toBeUndefined();
    expect(store.resolve(j.id as string)).not.toBeNull();
  });
  it('sanitizes a hostile name', async () => {
    const r = await post('x', { 'X-File-Name': encodeURIComponent('..\\..\\Windows\\CON.txt') });
    const j = (await r.json()) as { name: string; id: string };
    expect(j.name).toBe('_CON.txt');
    expect(store.resolve(j.id)!.path.startsWith(path.join(dir, 'uploads'))).toBe(true);
  });
  it('413 with a Thai message when the declared size is over the cap', async () => {
    const r = await post(Buffer.alloc(1500), { 'X-File-Name': 'big.bin' });
    expect(r.status).toBe(413);
    expect(((await r.json()) as { error: string }).error).toContain('ใหญ่เกิน');
  });
  it('413 when a chunked body grows past the cap (no content-length)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/upload', method: 'POST', headers: { 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write(Buffer.alloc(600));
      req.write(Buffer.alloc(600));
      req.end();
    });
    expect(status).toBe(413);
  });
  it('403 for a foreign origin, 400 for an empty body, 405 for GET, 204 preflight allows X-File-Name', async () => {
    expect((await post('x', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('')).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/upload`)).status).toBe(405);
    const pre = await fetch(`http://127.0.0.1:${port}/api/upload`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('X-File-Name');
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
  it('ignores other paths', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/upload/extra`);
    expect(r.status).toBe(404);
  });
});

describe('buildUserContent', () => {
  const rec = (p: string, size: number, name = 'x'): StoredUpload => ({ id: 'i', name, mime: 'application/octet-stream', size, path: p });
  it('without attachments it is the plain text (unchanged behaviour)', () => {
    expect(buildUserContent('hello', [])).toBe('hello');
  });
  it('a png becomes an image block plus ONE text block with the text and the path line', () => {
    const c = buildUserContent('สีอะไร', [rec('C:\\u\\a-shot.png', PNG.length)], () => PNG);
    expect(c).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
      { type: 'text', text: 'สีอะไร\n[ไฟล์แนบ] C:\\u\\a-shot.png' },
    ]);
  });
  it('a non-image file is only a path line; text-only attachments have no empty text', () => {
    const c = buildUserContent('', [rec('C:\\u\\a-doc.pdf', 10)], () => Buffer.from('%PDF-1.4'));
    expect(c).toEqual([{ type: 'text', text: '[ไฟล์แนบ] C:\\u\\a-doc.pdf' }]);
  });
  it('trusts the bytes, not the extension: a .png that is not an image stays a path line', () => {
    const c = buildUserContent('x', [rec('C:\\u\\fake.png', 5)], () => Buffer.from('hello')) as { type: string }[];
    expect(c.map((b) => b.type)).toEqual(['text']);
  });
  it('an image over 5 MB is not inlined (and not even read)', () => {
    let reads = 0;
    const c = buildUserContent('x', [rec('C:\\u\\big.png', INLINE_IMAGE_MAX_BYTES + 1)], () => {
      reads++;
      return PNG;
    }) as { type: string }[];
    expect(c.map((b) => b.type)).toEqual(['text']);
    expect(reads).toBe(0);
    const edge = buildUserContent('x', [rec('C:\\u\\ok.png', INLINE_IMAGE_MAX_BYTES)], () => PNG) as { type: string }[];
    expect(edge.map((b) => b.type)).toEqual(['image', 'text']);
  });
  it('an unreadable file still gets its path line', () => {
    const c = buildUserContent('x', [rec('C:\\u\\gone.png', 5)], () => {
      throw new Error('ENOENT');
    });
    expect(c).toEqual([{ type: 'text', text: 'x\n[ไฟล์แนบ] C:\\u\\gone.png' }]);
  });
  it('sniffs the four image formats', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('BM......'))).toBeNull();
  });
});

describe('send / start commands with attachments', () => {
  const ID = '3f2b8c1a-1111-4222-8333-444444444444';
  const send = (extra: Record<string, unknown>) => parseClientMsg({ type: 'send', reqId: 'r1', sessionId: 's1', ...extra });
  it('accepts attachments with text, or without text', () => {
    expect(send({ text: 'hi', attachments: [ID] })).toMatchObject({ ok: true, msg: { text: 'hi', attachments: [ID] } });
    expect(send({ text: '', attachments: [ID] })).toMatchObject({ ok: true, msg: { text: '', attachments: [ID] } });
  });
  it('still refuses empty text without attachments, and bad / too many ids', () => {
    expect(send({ text: '' }).ok).toBe(false);
    expect(send({ text: ' ', attachments: [] }).ok).toBe(false);
    expect(send({ text: 'x', attachments: ['../etc'] }).ok).toBe(false);
    expect(send({ text: 'x', attachments: 'nope' }).ok).toBe(false);
    expect(send({ text: 'x', attachments: Array.from({ length: 11 }, (_, i) => `3f2b8c1a-1111-4222-8333-4444444444${String(i).padStart(2, '0')}`) }).ok).toBe(false);
  });
  it('without attachments the message has no attachments field', () => {
    expect(send({ text: 'hi' })).toEqual({ ok: true, msg: { type: 'send', reqId: 'r1', sessionId: 's1', text: 'hi' } });
  });
  it('start takes attachments with an empty prompt', () => {
    const r = parseClientMsg({ type: 'start', reqId: 'r1', cwd: 'C:\\x', model: 'haiku', effort: 'low', prompt: '', attachments: [ID] });
    expect(r).toMatchObject({ ok: true, msg: { prompt: '', attachments: [ID] } });
    expect(parseClientMsg({ type: 'start', reqId: 'r1', cwd: 'C:\\x', model: 'haiku', effort: 'low', prompt: '' }).ok).toBe(false);
  });
});

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 777;
  written: Record<string, any>[] = [];
  private buf = '';
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.written.push(JSON.parse(this.buf.slice(0, i)));
        this.buf = this.buf.slice(i + 1);
      }
    });
  }
  kill(): boolean {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

describe('Runner with attachments', () => {
  it('writes an image block + path line; an unknown id sends and starts nothing', async () => {
    const store = new UploadStore(path.join(tmp, 'uploads'));
    const rec = store.save('shot.png', 'image/png', PNG);
    const children: FakeChild[] = [];
    const runner = new Runner({
      allowedCwds: () => [tmp],
      uploads: store,
      spawn: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
    });
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 20));
    expect(children[0].written[0].message.content).toBe('hi'); // plain text stays a plain string
    runner.send(id, 'สีอะไร', [rec.id]);
    await new Promise((r) => setTimeout(r, 20));
    const m = children[0].written[1].message;
    expect(m.role).toBe('user');
    expect(m.content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
    expect(m.content[1].text).toBe(`สีอะไร\n[ไฟล์แนบ] ${store.resolve(rec.id)!.path}`);

    const before = children[0].written.length;
    expect(() => runner.send(id, 'x', ['00000000-0000-4000-8000-000000000000'])).toThrow(CommandError);
    expect(children[0].written.length).toBe(before);
    expect(() => runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'p', attachments: ['00000000-0000-4000-8000-000000000000'] })).toThrow(/ไม่พบไฟล์แนบ/);
    expect(children.length).toBe(1); // no second child was spawned
    runner.shutdown();
  });
  it('a runner without an upload store refuses every attachment id', () => {
    const runner = new Runner({ allowedCwds: () => [tmp], spawn: () => new FakeChild() });
    expect(() => runner.userContent('x', ['3f2b8c1a-1111-4222-8333-444444444444'])).toThrow(CommandError);
  });
});

describe('parser never leaks attachment bytes', () => {
  const B64 = PNG.toString('base64');
  const line = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: '2026-11-24T10:00:00.000Z', origin: { kind: 'human' } });
  const run = (lines: string[]) => {
    const st = createState();
    for (const l of lines) ingestLine(st, l);
    return { st, d: derive(st, { now: Date.parse('2026-11-24T10:00:05.000Z'), processAlive: true, mtime: Date.parse('2026-11-24T10:00:00.000Z') } as never) };
  };
  it('shows 📎 names in the timeline and the title, never base64 or the folder path', () => {
    const p = 'C:\\Users\\x\\.claude-control-room\\uploads\\2026-11-24\\3f2b8c1a-1111-4222-8333-444444444444-shot.png';
    const { d } = run([line([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } }, { type: 'text', text: `สีอะไร\n[ไฟล์แนบ] ${p}` }])]);
    const user = d.timeline.filter((e) => e.kind === 'user');
    expect(user).toHaveLength(1);
    expect(user[0].text).toBe('สีอะไร\n📎 shot.png');
    expect(JSON.stringify(d)).not.toContain(B64.slice(0, 40));
    expect(d.title).toBe('สีอะไร 📎 shot.png');
  });
  it('skips the "[Image: source: ...]" note Claude adds after an image', () => {
    const { d } = run([line([{ type: 'text', text: 'ดูรูป' }]), line([{ type: 'text', text: '[Image: source: C:/Temp/images/1.png]' }])]);
    expect(d.timeline.map((e) => e.text)).toEqual(['ดูรูป']);
  });
  it('an attachment-only message titles the session with its file name', () => {
    const p = 'C:\\u\\uploads\\2026-11-24\\3f2b8c1a-1111-4222-8333-444444444444-spec.pdf';
    const { d } = run([line([{ type: 'text', text: `[ไฟล์แนบ] ${p}` }])]);
    expect(d.title).toBe('📎 spec.pdf');
    expect(d.timeline[0].text).toBe('📎 spec.pdf');
  });
});
