import { describe, expect, it } from 'vitest';
import { UPLOAD_MAX_BYTES } from '../../shared/uploads';
import { canSubmit, chipsReducer, dragHasFiles, extractFiles, isUploading, pastedName, planAdd, readyIds, uploadFile, type Chip } from './attach';

const chip = (key: string, over: Partial<Chip> = {}): Chip => ({ key, name: `${key}.png`, size: 10, mime: 'image/png', status: 'uploading', ...over });
const file = (name: string, size = 10, type = 'image/png') => ({ name, size, type }) as unknown as File;

describe('chipsReducer', () => {
  it('add -> done -> remove -> clear', () => {
    let s = chipsReducer([], { type: 'add', chips: [chip('a'), chip('b')] });
    expect(s.map((c) => c.status)).toEqual(['uploading', 'uploading']);
    expect(isUploading(s)).toBe(true);
    s = chipsReducer(s, { type: 'done', key: 'a', id: 'id-a', name: 'a.png' });
    expect(readyIds(s)).toEqual(['id-a']);
    s = chipsReducer(s, { type: 'fail', key: 'b', error: 'ไฟล์ใหญ่เกิน 25 MB' });
    expect(s[1]).toMatchObject({ status: 'error', error: 'ไฟล์ใหญ่เกิน 25 MB' });
    expect(isUploading(s)).toBe(false);
    s = chipsReducer(s, { type: 'remove', key: 'a' });
    expect(s.map((c) => c.key)).toEqual(['b']);
    expect(chipsReducer(s, { type: 'clear' })).toEqual([]);
  });
  it('done / fail for an unknown key change nothing (chip removed while uploading)', () => {
    const s = [chip('a')];
    expect(chipsReducer(s, { type: 'done', key: 'zzz', id: 'x', name: 'x' })).toEqual(s);
    expect(chipsReducer(s, { type: 'fail', key: 'zzz', error: 'x' })).toEqual(s);
  });
  it('does not mutate the old state', () => {
    const s = [chip('a')];
    chipsReducer(s, { type: 'done', key: 'a', id: 'i', name: 'a' });
    expect(s[0].status).toBe('uploading');
  });
});

describe('canSubmit: text only, attachments only, both, never while uploading', () => {
  const ready = chip('r', { status: 'ready', id: 'id-r' });
  it('cases', () => {
    expect(canSubmit('hi', [])).toBe(true);
    expect(canSubmit('  ', [])).toBe(false);
    expect(canSubmit('', [ready])).toBe(true);
    expect(canSubmit('hi', [ready])).toBe(true);
    expect(canSubmit('hi', [ready, chip('u')])).toBe(false);
    expect(canSubmit('', [chip('e', { status: 'error' })])).toBe(false);
  });
});

describe('planAdd', () => {
  it('accepts normal files and refuses too big / empty ones with a Thai reason', () => {
    const r = planAdd([], [{ name: 'a.png', size: 100 }, { name: 'big.zip', size: UPLOAD_MAX_BYTES + 1 }, { name: 'empty.txt', size: 0 }]);
    expect(r.accept).toEqual([0]);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toContain('big.zip');
    expect(r.problems[0]).toContain('ใหญ่เกิน');
    expect(r.problems[1]).toContain('ว่างเปล่า');
  });
  it('stops at 10 files per message; failed chips do not count', () => {
    const ten = Array.from({ length: 10 }, (_, i) => chip(`c${i}`));
    expect(planAdd(ten, [{ name: 'x', size: 1 }]).accept).toEqual([]);
    expect(planAdd(ten, [{ name: 'x', size: 1 }]).problems[0]).toContain('10');
    const nine = [...ten.slice(0, 9), chip('bad', { status: 'error' })];
    expect(planAdd(nine, [{ name: 'x', size: 1 }, { name: 'y', size: 1 }]).accept).toEqual([0]);
    expect(planAdd([], Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, size: 1 }))).accept).toHaveLength(10);
  });
});

describe('pastedName', () => {
  const t = new Date(2026, 10, 24, 9, 5, 7);
  it('names a pasted screenshot by time and type; keeps real file names', () => {
    expect(pastedName({ name: 'image.png', type: 'image/png' }, t)).toBe('screenshot-20261124-090507.png');
    expect(pastedName({ name: '', type: 'image/jpeg' }, t)).toBe('screenshot-20261124-090507.jpg');
    expect(pastedName({ name: 'image.png', type: 'image/png' }, t, 1)).toBe('screenshot-20261124-090507-2.png');
    expect(pastedName({ name: 'ใบเสนอราคา.pdf', type: 'application/pdf' }, t)).toBe('ใบเสนอราคา.pdf');
  });
});

describe('extractFiles / dragHasFiles', () => {
  const a = file('a.png');
  const b = file('b.pdf', 5, 'application/pdf');
  it('uses file items, ignores text items, and does not double count items + files', () => {
    const dt = {
      items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => a }, { kind: 'file', getAsFile: () => b }],
      files: [a, b],
    };
    expect(extractFiles(dt)).toEqual([a, b]);
  });
  it('falls back to files, and gives [] for plain text paste or nothing', () => {
    expect(extractFiles({ files: [a] })).toEqual([a]);
    expect(extractFiles({ items: [{ kind: 'string', getAsFile: () => null }], files: [] })).toEqual([]);
    expect(extractFiles(null)).toEqual([]);
  });
  it('dragHasFiles is true only for file drags', () => {
    expect(dragHasFiles({ types: ['Files'] })).toBe(true);
    expect(dragHasFiles({ types: ['text/plain', 'Files'] })).toBe(true);
    expect(dragHasFiles({ types: ['text/plain', 'text/uri-list'] })).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});

describe('uploadFile', () => {
  const blob = Object.assign(new Blob(['abc'], { type: 'image/png' }), { name: 'x.png' });
  it('posts the raw file with an encoded name and returns the server record', async () => {
    let seen: { url: string; headers: Record<string, string>; method: string } | null = null;
    const r = await uploadFile(blob, 'รูป 1.png', 'http://127.0.0.1:8790', async (url, init) => {
      seen = { url, headers: init.headers, method: init.method };
      return { ok: true, json: async () => ({ ok: true, id: 'abc', name: 'รูป 1.png', mime: 'image/png', size: 3 }) };
    });
    expect(r).toEqual({ id: 'abc', name: 'รูป 1.png', mime: 'image/png', size: 3 });
    expect(seen!.url).toBe('http://127.0.0.1:8790/api/upload');
    expect(seen!.method).toBe('POST');
    expect(decodeURIComponent(seen!.headers['X-File-Name'])).toBe('รูป 1.png');
    expect(seen!.headers['Content-Type']).toBe('image/png');
  });
  it('turns a 413 into the server Thai message, and a network error into a Thai message', async () => {
    await expect(uploadFile(blob, 'x.png', 'http://h', async () => ({ ok: false, json: async () => ({ ok: false, error: 'ไฟล์ใหญ่เกิน 25 MB' }) }))).rejects.toThrow('ไฟล์ใหญ่เกิน 25 MB');
    await expect(
      uploadFile(blob, 'x.png', 'http://h', async () => {
        throw new TypeError('fetch failed');
      }),
    ).rejects.toThrow('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    await expect(uploadFile(blob, 'x.png', 'http://h', async () => ({ ok: false, json: async () => Promise.reject(new Error('html')) }))).rejects.toThrow('อัปโหลดไม่สำเร็จ');
  });
});
