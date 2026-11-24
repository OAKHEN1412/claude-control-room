import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClipSettings, ClipStartInput } from '../../shared/protocol';
import { CLIP_PRESET_MAX } from '../../shared/protocol';
import { ClipService, clipConcurrency, suggestPresetName } from '../src/clips';
import { parseClientMsg } from '../src/commands';
import { WorklogDb } from '../src/db';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-clipq-'));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const S: ClipSettings = { length: '30s', ratio: '9:16', lang: 'th', voice: false, music: false, cast: ['เทค'] };
const NO_LEMO = () => ({ installed: false, styles: [], categories: [] });
function req(topic: string, over: Partial<ClipStartInput> = {}): ClipStartInput {
  return { topic, points: '', settings: S, styleId: 'ours:whiteboard', voiceId: null, scriptModel: 'sonnet', builderModel: 'opus', effort: 'high', ...over };
}

function setup(concurrency = 2) {
  const db = new WorklogDb(':memory:');
  const alive = new Set<string>();
  let n = 0;
  let ids = 0;
  const startedTopics: string[] = [];
  const runner = {
    start: (r: { prompt: string }) => {
      const id = `sess-${++n}`;
      alive.add(id);
      startedTopics.push(/หัวข้อ: (.*)/.exec(r.prompt)?.[1] ?? '?');
      return id;
    },
    send: () => undefined,
    isAlive: (id: string) => alive.has(id),
  };
  const svc = new ClipService({
    db,
    runner: runner as never,
    sessions: () => [],
    lemo: NO_LEMO,
    videosDir: tmpDir(),
    concurrency,
    newId: () => `id-${++ids}`,
  });
  return { svc, db, alive, startedTopics };
}

describe('clip queue concurrency', () => {
  it('reads CR_CLIP_CONCURRENCY, default 2, ignores junk', () => {
    expect(clipConcurrency({})).toBe(2);
    expect(clipConcurrency({ CR_CLIP_CONCURRENCY: '3' })).toBe(3);
    expect(clipConcurrency({ CR_CLIP_CONCURRENCY: '0' })).toBe(2);
    expect(clipConcurrency({ CR_CLIP_CONCURRENCY: 'x' })).toBe(2);
  });

  it('3 queued with 2 slots: two start, the third waits and starts when one finishes', () => {
    const { svc, alive, startedTopics } = setup(2);
    const a = svc.enqueue(req('A'));
    const b = svc.enqueue(req('B'));
    const c = svc.enqueue(req('C'));
    expect(a.sessionId).toBe('sess-1');
    expect(b.sessionId).toBe('sess-2');
    expect(c.sessionId).toBeNull();
    expect(startedTopics).toEqual(['A', 'B']);
    expect(svc.queue().map((q) => q.topic)).toEqual(['C']);
    expect(svc.jobs()).toHaveLength(2);
    svc.pump(); // nothing freed yet
    expect(startedTopics).toEqual(['A', 'B']);
    alive.delete('sess-1'); // job 1 ended
    svc.pump();
    expect(startedTopics).toEqual(['A', 'B', 'C']);
    expect(svc.queue()).toEqual([]);
    expect(svc.jobs()).toHaveLength(3);
  });

  it('a job that reached พร้อม render frees its slot even though its session is alive', () => {
    const { svc, db, startedTopics } = setup(1);
    svc.enqueue(req('A'));
    svc.enqueue(req('B'));
    expect(startedTopics).toEqual(['A']);
    db.setClipStage('sess-1', 4);
    svc.pump();
    expect(startedTopics).toEqual(['A', 'B']);
  });

  it('starts waiting clips oldest first', () => {
    const { svc, alive, startedTopics } = setup(1);
    svc.enqueue(req('A'));
    svc.enqueue(req('B'));
    svc.enqueue(req('C'));
    alive.delete('sess-1');
    svc.pump();
    expect(startedTopics).toEqual(['A', 'B']);
    expect(svc.queue().map((q) => q.topic)).toEqual(['C']);
  });

  it('removing a waiting clip means it never starts; a started one cannot be dequeued', () => {
    const { svc, alive, startedTopics } = setup(1);
    svc.enqueue(req('A'));
    const b = svc.enqueue(req('B'));
    svc.enqueue(req('C'));
    svc.dequeue(b.queueId);
    expect(svc.queue().map((q) => q.topic)).toEqual(['C']);
    expect(() => svc.dequeue(b.queueId)).toThrow();
    alive.delete('sess-1');
    svc.pump();
    expect(startedTopics).toEqual(['A', 'C']);
    expect(() => svc.dequeue('nope')).toThrow();
  });

  it('refuses a bad request at once; a failing start stays listed with its error and never blocks others', () => {
    const { svc } = setup(2);
    expect(() => svc.enqueue(req('X', { styleId: 'ours:nope' }))).toThrow();
    expect(() => svc.enqueue(req('X', { settings: { ...S, voice: true } }))).toThrow();
    expect(svc.queue()).toEqual([]);
    const db = new WorklogDb(':memory:');
    let fail = true;
    const svc2 = new ClipService({
      db,
      runner: {
        start: () => {
          if (fail) throw new Error('boom');
          return 's9';
        },
        send: () => undefined,
        isAlive: () => true,
      } as never,
      sessions: () => [],
      lemo: NO_LEMO,
      videosDir: tmpDir(),
      concurrency: 2,
    });
    const r = svc2.enqueue(req('F'));
    expect(r.sessionId).toBeNull();
    expect(svc2.queue()[0].error).toBe('boom');
    fail = false;
    svc2.enqueue(req('G'));
    expect(svc2.jobs().map((j) => j.topic)).toEqual(['G']);
    expect(svc2.queue().map((q) => q.topic)).toEqual(['F']); // not retried
  });

  it('emits change when the queue moves', () => {
    const { svc } = setup(1);
    let n = 0;
    svc.on('change', () => n++);
    svc.enqueue(req('A'));
    const beforeB = n;
    const b = svc.enqueue(req('B')); // waits, nothing starts: browsers must still hear about it
    expect(n).toBeGreaterThan(beforeB);
    const before = n;
    svc.dequeue(b.queueId);
    expect(n).toBe(before + 1);
  });
});

describe('clip presets in the db', () => {
  it('saves, renames, updates, deletes and keeps order', () => {
    const { svc, db } = setup();
    const a = svc.savePreset({ name: 'PLC · TikTok', settings: S, styleId: 'ours:whiteboard' });
    const b = svc.savePreset({ name: 'ยาว', settings: { ...S, length: '3min', ratio: '16:9' }, styleId: 'ours:voxel3d' });
    expect(svc.presets().map((p) => p.name)).toEqual(['PLC · TikTok', 'ยาว']);
    svc.savePreset({ id: a, name: 'PLC · Reels', settings: { ...S, length: '60s' }, styleId: 'ours:whiteboard' });
    const got = db.getPreset(a)!;
    expect(got).toMatchObject({ name: 'PLC · Reels', suggested: false });
    expect(got.settings.length).toBe('60s');
    expect(svc.presets().map((p) => p.id)).toEqual([a, b]);
    svc.deletePreset(a);
    expect(svc.presets().map((p) => p.id)).toEqual([b]);
    expect(() => svc.deletePreset(a)).toThrow();
  });

  it('refuses empty / duplicate names, unknown ids, unknown styles and a full list', () => {
    const { svc } = setup();
    svc.savePreset({ name: 'A', settings: S, styleId: 'ours:whiteboard' });
    expect(() => svc.savePreset({ name: '  ', settings: S, styleId: 'ours:whiteboard' })).toThrow();
    expect(() => svc.savePreset({ name: 'A', settings: S, styleId: 'ours:whiteboard' })).toThrow();
    expect(() => svc.savePreset({ id: 'ghost', name: 'Z', settings: S, styleId: 'ours:whiteboard' })).toThrow();
    expect(() => svc.savePreset({ name: 'Z', settings: S, styleId: 'ours:nope' })).toThrow();
    for (let i = 1; i < CLIP_PRESET_MAX; i++) svc.savePreset({ name: `P${i}`, settings: S, styleId: 'ours:whiteboard' });
    expect(() => svc.savePreset({ name: 'one too many', settings: S, styleId: 'ours:whiteboard' })).toThrow();
  });

  function clipRow(db: WorklogDb, id: string, settings: ClipSettings, styleId: string, createdAt: number) {
    db.insertClip({ sessionId: id, topic: id, slug: id, cwd: '/x', styleId, styleName: styleId.split(':')[1], settings, voiceId: null, scriptModel: 'sonnet', builderModel: 'opus', createdAt, stage: 0, ready: false, renderRequested: false });
  }

  it('seeds at most 3 suggested presets from distinct past settings, once', () => {
    const db = new WorklogDb(':memory:');
    clipRow(db, 'a', S, 'ours:whiteboard', 1);
    clipRow(db, 'b', S, 'ours:whiteboard', 2);
    clipRow(db, 'c', { ...S, ratio: '16:9' }, 'ours:whiteboard', 3);
    clipRow(db, 'd', { ...S, length: '3min' }, 'ours:voxel3d', 4);
    clipRow(db, 'e', { ...S, lang: 'en' }, 'ours:voxel3d', 5);
    let i = 0;
    const make = () => new ClipService({ db, runner: {} as never, sessions: () => [], lemo: NO_LEMO, videosDir: tmpDir(), newId: () => `p${++i}` });
    const svc = make();
    const ps = svc.presets();
    expect(ps).toHaveLength(3);
    expect(ps.every((p) => p.suggested)).toBe(true);
    expect(ps[0].settings).toEqual(S); // used twice: first
    expect(ps[0].name).toBe(suggestPresetName(S, 'whiteboard'));
    for (const p of ps) svc.deletePreset(p.id);
    expect(make().presets()).toEqual([]); // not seeded again
  });

  it('does not seed from an empty history, and editing a suggested preset clears the mark', () => {
    const db = new WorklogDb(':memory:');
    const svc = new ClipService({ db, runner: {} as never, sessions: () => [], lemo: NO_LEMO, videosDir: tmpDir() });
    expect(svc.presets()).toEqual([]);
    db.savePreset({ id: 'x', name: 'S', settings: S, styleId: 'ours:whiteboard', createdAt: 1, suggested: true });
    expect(db.getPreset('x')!.suggested).toBe(true);
    svc.savePreset({ id: 'x', name: 'S2', settings: S, styleId: 'ours:whiteboard' });
    expect(db.getPreset('x')!.suggested).toBe(false);
  });
});

describe('protocol parse of preset / queue messages', () => {
  const base = { reqId: 'r1' };
  it('accepts a valid preset save, with and without id', () => {
    const r = parseClientMsg({ ...base, type: 'clip_preset_save', name: ' PLC ', settings: S, styleId: 'ours:whiteboard' });
    expect(r).toMatchObject({ ok: true, msg: { type: 'clip_preset_save', name: 'PLC', styleId: 'ours:whiteboard' } });
    const r2 = parseClientMsg({ ...base, type: 'clip_preset_save', id: 'abc-1', name: 'x', settings: S, styleId: 'lemo:foo' });
    expect(r2).toMatchObject({ ok: true, msg: { id: 'abc-1' } });
  });
  it('rejects bad names, settings, styles and ids', () => {
    expect(parseClientMsg({ ...base, type: 'clip_preset_save', name: '', settings: S, styleId: 'ours:a' }).ok).toBe(false);
    expect(parseClientMsg({ ...base, type: 'clip_preset_save', name: 'x'.repeat(61), settings: S, styleId: 'ours:a' }).ok).toBe(false);
    expect(parseClientMsg({ ...base, type: 'clip_preset_save', name: 'x', settings: { ...S, ratio: '4:3' }, styleId: 'ours:a' }).ok).toBe(false);
    expect(parseClientMsg({ ...base, type: 'clip_preset_save', name: 'x', settings: S, styleId: 'nope' }).ok).toBe(false);
    expect(parseClientMsg({ ...base, type: 'clip_preset_save', id: '../x', name: 'x', settings: S, styleId: 'ours:a' }).ok).toBe(false);
  });
  it('parses delete and dequeue', () => {
    expect(parseClientMsg({ ...base, type: 'clip_preset_delete', id: 'p-1' })).toMatchObject({ ok: true, msg: { type: 'clip_preset_delete', id: 'p-1' } });
    expect(parseClientMsg({ ...base, type: 'clip_dequeue', id: 'q_1' })).toMatchObject({ ok: true, msg: { type: 'clip_dequeue', id: 'q_1' } });
    expect(parseClientMsg({ ...base, type: 'clip_dequeue' }).ok).toBe(false);
    expect(parseClientMsg({ ...base, type: 'clip_dequeue', id: 'a b' }).ok).toBe(false);
  });
});
