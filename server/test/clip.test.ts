import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClipSettings, ClipStartInput, SessionInfo } from '../../shared/protocol';
import { inferStage } from '../src/clipProgress';
import { NO_RENDER_RULE, buildClipPrompt, slugify } from '../src/clipPrompt';
import { ClipService, RENDER_MESSAGE, freeFolderName } from '../src/clips';
import { parseClientMsg } from '../src/commands';
import { WorklogDb } from '../src/db';
import { OUR_STYLES, loadOurStyles } from '../src/ourStyles';
import { ensureStill, findRender, stillKey } from '../src/stills';
import { loadLemoStyles, parseLemoStyles } from '../src/styles';
import { SEED_VOICES, VoiceError, VoiceService, cleanSample, parseKey, voiceCacheKey } from '../src/voice';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-clip-'));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SETTINGS: ClipSettings = { length: '30s', ratio: '9:16', lang: 'th', voice: true, music: false, cast: ['เทค', 'บอท'] };
function req(over: Partial<ClipStartInput> = {}): ClipStartInput {
  return { topic: 'FRL unit คืออะไร', points: 'ความหมาย, ตัวอย่าง', settings: SETTINGS, styleId: 'ours:whiteboard', voiceId: 'KhBRXgEQjvfdIyXOu7G3', scriptModel: 'sonnet', builderModel: 'opus', effort: 'high', ...over };
}

describe('stills cache', () => {
  it('has no still when no render file exists', async () => {
    const r = await ensureStill({ id: 'x', renders: [path.join(tmpDir(), 'none.mp4')] }, { dir: tmpDir() });
    expect(r.file).toBeNull();
  });

  it('cuts once, then serves from cache; a changed render makes a new key', async () => {
    const dir = tmpDir();
    const render = path.join(tmpDir(), 'a.mp4');
    fs.writeFileSync(render, 'video-bytes');
    let calls = 0;
    const ffmpeg = async (args: string[]) => {
      calls++;
      fs.writeFileSync(args[args.length - 1], 'jpg');
    };
    const style = { id: 'whiteboard', renders: [path.join(dir, 'missing.mp4'), render] };
    const a = await ensureStill(style, { dir, ffmpeg });
    const b = await ensureStill(style, { dir, ffmpeg });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.file).toBe(a.file);
    expect(calls).toBe(1);
    const r1 = findRender([render])!;
    fs.writeFileSync(render, 'a-longer-video-bytes');
    expect(stillKey('whiteboard', findRender([render])!)).not.toBe(stillKey('whiteboard', r1));
  });

  it('falls back to the first frame and reports an error when ffmpeg fails', async () => {
    const render = path.join(tmpDir(), 'a.mp4');
    fs.writeFileSync(render, 'x');
    const seen: string[][] = [];
    const r = await ensureStill({ id: 's', renders: [render] }, { dir: tmpDir(), ffmpeg: async (a) => { seen.push(a); throw new Error('boom'); } });
    expect(r.file).toBeNull();
    expect(r.error).toContain('boom');
    expect(seen.map((a) => a[a.indexOf('-ss') + 1])).toEqual(['5', '0']);
  });

  it('all five of our styles are defined', () => {
    expect(OUR_STYLES.map((s) => s.id)).toEqual(['whiteboard', 'voxel3d', 'motion2d', 'screendemo', 'freshy']);
  });
});

describe('voice cache', () => {
  it('key depends on voice, model and text', () => {
    const k = voiceCacheKey('v1', 'eleven_v3', 'สวัสดี');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(voiceCacheKey('v1', 'eleven_v3', 'สวัสดี')).toBe(k);
    expect(voiceCacheKey('v2', 'eleven_v3', 'สวัสดี')).not.toBe(k);
    expect(voiceCacheKey('v1', 'eleven_v2', 'สวัสดี')).not.toBe(k);
    expect(voiceCacheKey('v1', 'eleven_v3', 'สวัสดีครับ')).not.toBe(k);
    expect(voiceCacheKey('ab', 'c', 'd')).not.toBe(voiceCacheKey('a', 'bc', 'd'));
  });

  it('limits the sample to 120 characters', () => {
    expect(cleanSample('x'.repeat(120))).not.toBeNull();
    expect(cleanSample('x'.repeat(121))).toBeNull();
    expect(cleanSample('   ')).toBeNull();
  });

  it('finds the sk_ token and never the backup code line', () => {
    expect(parseKey('key = sk_abcdefghijklmnop1234\n\nbackupcode: 9f42')).toBe('sk_abcdefghijklmnop1234');
    expect(parseKey('nothing here')).toBeNull();
  });

  function svc(fetchFn: typeof fetch, key: string | null = 'sk_testkeytestkeytest12') {
    const store = { listVoices: () => [], addVoice: () => {}, removeVoice: () => false };
    return new VoiceService({ store, getKey: () => key, cacheDir: tmpDir(), fetchFn });
  }

  it('calls the API once for a repeated request, with UTF-8 JSON and eleven_v3', async () => {
    const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: Buffer.from(init.body as Buffer).toString('utf8'), headers: init.headers as Record<string, string> });
      return new Response(new Uint8Array(2000), { status: 200 });
    }) as unknown as typeof fetch;
    const s = svc(fetchFn);
    const a = await s.preview('KhBRXgEQjvfdIyXOu7G3', 'สวัสดีครับ');
    const b = await s.preview('KhBRXgEQjvfdIyXOu7G3', 'สวัสดีครับ');
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(a.hash).toBe(b.hash);
    expect(s.apiCalls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain('/v1/text-to-speech/KhBRXgEQjvfdIyXOu7G3');
    const body = JSON.parse(seen[0].body) as { text: string; model_id: string };
    expect(body).toMatchObject({ text: 'สวัสดีครับ', model_id: 'eleven_v3' });
    expect(s.audioFile(a.hash)).not.toBeNull();
  });

  it('shares one call between identical concurrent requests and never leaks the key in errors', async () => {
    let n = 0;
    const ok = (async () => {
      n++;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(new Uint8Array(2000), { status: 200 });
    }) as unknown as typeof fetch;
    const s = svc(ok);
    await Promise.all([s.preview('KhBRXgEQjvfdIyXOu7G3', 'a'), s.preview('KhBRXgEQjvfdIyXOu7G3', 'a')]);
    expect(n).toBe(1);
    const bad = svc((async () => new Response('{"detail":"sk_testkeytestkeytest12"}', { status: 401 })) as unknown as typeof fetch);
    await expect(bad.preview('KhBRXgEQjvfdIyXOu7G3', 'b')).rejects.toSatisfy((e: unknown) => e instanceof VoiceError && !e.message.includes('sk_'));
  });

  it('refuses a bad voice id, an over-long sample and a missing key without calling out', async () => {
    let n = 0;
    const f = (async () => { n++; return new Response(new Uint8Array(2000)); }) as unknown as typeof fetch;
    const s = svc(f, null);
    await expect(s.preview('../x', 'hi')).rejects.toBeInstanceOf(VoiceError);
    await expect(s.preview('KhBRXgEQjvfdIyXOu7G3', 'x'.repeat(121))).rejects.toBeInstanceOf(VoiceError);
    await expect(s.preview('KhBRXgEQjvfdIyXOu7G3', 'hi')).rejects.toBeInstanceOf(VoiceError);
    expect(n).toBe(0);
  });

  it('voice ids persist in the DB; seeds cannot be removed', () => {
    const file = path.join(tmpDir(), 'a.db');
    const db = new WorklogDb(file);
    db.seedVoices(SEED_VOICES, 1);
    db.addVoice('ZZZZZZZZZZ', 'mine');
    db.close();
    const db2 = new WorklogDb(file);
    db2.seedVoices(SEED_VOICES, 2);
    expect(db2.listVoices().map((v) => v.id)).toEqual([...SEED_VOICES.map((v) => v.id), 'ZZZZZZZZZZ']);
    expect(db2.removeVoice('KhBRXgEQjvfdIyXOu7G3')).toBe(false);
    expect(db2.removeVoice('ZZZZZZZZZZ')).toBe(true);
    db2.close();
  });
});

describe('style list', () => {
  it('is "not installed" without the file', () => {
    const l = loadLemoStyles(path.join(tmpDir(), 'nope.json'));
    expect(l).toEqual({ installed: false, styles: [], categories: [] });
  });

  it('reads styles, groups categories, drops bad rows and duplicates', () => {
    const l = parseLemoStyles(JSON.stringify([
      { id: 'a', name: 'A', category: 'X', stylePath: 'p', thumb: 't.jpg' },
      { id: 'a', name: 'dup', category: 'X' },
      { id: 'b c', name: 'bad id', category: 'Y' },
      { id: 'b', name: 'B', category: 'Y' },
      null,
    ]));
    expect(l.installed).toBe(true);
    expect(l.styles.map((s) => s.id)).toEqual(['a', 'b']);
    expect(l.categories).toEqual(['X', 'Y']);
  });

  it('reports a broken file as not installed with a reason', () => {
    const f = path.join(tmpDir(), 'l.json');
    fs.writeFileSync(f, '{oops');
    const l = loadLemoStyles(f);
    expect(l.installed).toBe(false);
    expect(l.error).toBeTruthy();
  });

  it('loads the real docs/lemo-styles.json when present', () => {
    const f = path.resolve(__dirname, '..', '..', 'docs', 'lemo-styles.json');
    if (!fs.existsSync(f)) return;
    const l = loadLemoStyles(f);
    expect(l.installed).toBe(true);
    expect(l.styles.length).toBeGreaterThan(50);
  });
});

describe('clip prompt', () => {
  const ours = OUR_STYLES[0];
  it('always carries the no-render rule and the stop phrase', () => {
    const p = buildClipPrompt({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(p).toContain(NO_RENDER_RULE);
    expect(p).toContain('ห้าม render');
    expect(p).toContain('พร้อม render');
    expect(p).toContain('ขั้น N/5');
    const q = buildClipPrompt({ req: req({ styleId: 'lemo:art-deco' }), style: { kind: 'lemo', style: { id: 'art-deco', name: 'Art Deco', category: 'Graphic & Type', stylePath: 'C:/l/art-deco', thumb: null } }, cwd: 'C:/v/x' });
    expect(q).toContain(NO_RENDER_RULE);
  });

  it('names our style source folder, or the lemo-opuscar skill with the style id', () => {
    const p = buildClipPrompt({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(p).toContain(ours.sourceDir);
    const q = buildClipPrompt({ req: req(), style: { kind: 'lemo', style: { id: 'art-deco', name: 'Art Deco', category: 'Graphic & Type', stylePath: 'C:/l/art-deco', thumb: null } }, cwd: 'C:/v/x' });
    expect(q).toContain('lemo-opuscar');
    expect(q).toContain('art-deco');
  });

  it('states settings, voice id + eleven_v3, and drops ElevenLabs when voice is off', () => {
    const p = buildClipPrompt({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(p).toContain('30 วินาที');
    expect(p).toContain('9:16');
    expect(p).toContain('KhBRXgEQjvfdIyXOu7G3');
    expect(p).toContain('eleven_v3');
    expect(p).not.toMatch(/sk_[A-Za-z0-9]{10}/);
    const q = buildClipPrompt({ req: req({ voiceId: null, settings: { ...SETTINGS, voice: false } }), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(q).not.toContain('KhBRXgEQjvfdIyXOu7G3');
    expect(q).toContain('ห้ามเรียก ElevenLabs');
  });

  it('freshy style forbids subagents', () => {
    const f = OUR_STYLES.find((s) => s.id === 'freshy')!;
    expect(buildClipPrompt({ req: req(), style: { kind: 'ours', style: f }, cwd: 'C:/v/x' })).toContain('ห้ามใช้ subagent');
  });

  it('slugify keeps Thai, drops punctuation, never returns empty', () => {
    expect(slugify('FRL unit คืออะไร?', 'f')).toBe('frl-unit-คืออะไร');
    expect(slugify('!!!', 'fallback')).toBe('fallback');
    expect(slugify('con', 'fb')).toBe('fb');
    expect(slugify('../../etc', 'f')).toBe('etc');
  });
});

describe('clip progress heuristic', () => {
  const t = (kind: 'user' | 'tool' | 'text' | 'error', text: string) => ({ kind, text });
  it('starts at บท', () => {
    expect(inferStage({ events: [] })).toBe(0);
  });
  it('never reads the user brief (it names every stage)', () => {
    expect(inferStage({ events: [t('user', 'ขั้น 5/5 พร้อม render')] })).toBe(0);
  });
  it('follows step markers in Claude text', () => {
    expect(inferStage({ events: [t('text', 'ขั้น 2/5 storyboard')] })).toBe(1);
    expect(inferStage({ events: [t('text', 'ขั้น 3/5 สร้าง scene')] })).toBe(2);
    expect(inferStage({ events: [], thought: 'ขั้น 4/5 preview' })).toBe(3);
  });
  it('พร้อม render only counts when asserted, not negated', () => {
    expect(inferStage({ events: [t('text', 'ขั้น 5/5 พร้อม render')] })).toBe(4);
    expect(inferStage({ events: [t('text', 'พร้อม render แล้ว รอคุณสั่ง')] })).toBe(4);
    expect(inferStage({ events: [t('text', 'ยังไม่พร้อม render')] })).toBe(0);
  });
  it('infers from files written and preview commands', () => {
    expect(inferStage({ events: [t('tool', 'เขียนไฟล์: STORYBOARD.md')] })).toBe(1);
    expect(inferStage({ events: [t('tool', 'เขียนไฟล์: scene1.html')] })).toBe(2);
    expect(inferStage({ events: [t('tool', 'คำสั่ง: npx hyperframes snapshot')] })).toBe(3);
    expect(inferStage({ events: [], files: ['.media/snap-w1/a.png'] })).toBe(3);
    expect(inferStage({ events: [t('tool', 'เขียนไฟล์: notes.txt')] })).toBe(0);
  });
  it('takes the highest signal', () => {
    expect(inferStage({ events: [t('text', 'ขั้น 4/5 preview'), t('tool', 'เขียนไฟล์: STORYBOARD.md')] })).toBe(3);
  });
});

describe('ClipService', () => {
  function setup() {
    const videos = tmpDir();
    const db = new WorklogDb(':memory:');
    const started: { cwd: string; model: string; prompt: string; trusted?: boolean }[] = [];
    const sent: [string, string][] = [];
    let alive = true;
    const runner = {
      start: (r: { cwd: string; model: string; prompt: string }, o?: { trustedCwd?: boolean }) => {
        started.push({ ...r, trusted: o?.trustedCwd });
        return 'sess-1';
      },
      send: (id: string, text: string) => void sent.push([id, text]),
      isAlive: () => alive,
    };
    let sessions: SessionInfo[] = [];
    const svc = new ClipService({
      db,
      runner: runner as never,
      sessions: () => sessions,
      lemo: () => ({ installed: false, styles: [], categories: [] }),
      videosDir: videos,
      scanThrottleMs: 0,
    });
    return { svc, db, videos, started, sent, setSessions: (s: SessionInfo[]) => (sessions = s), kill: () => (alive = false) };
  }
  const sess = (timeline: { kind: 'text' | 'tool' | 'user'; text: string }[]): SessionInfo => ({
    sessionId: 'sess-1', pid: 1, name: '', cwd: '', kind: '', title: '', model: null, effort: null, status: 'running', thought: '', startedAt: 0, lastActivity: 0,
    timeline: timeline.map((e) => ({ ts: 0, ...e })), subagents: [],
  });

  it('creates the folder, starts a trusted-cwd session with the brief and records the job', () => {
    const { svc, videos, started, db } = setup();
    const id = svc.start(req());
    expect(id).toBe('sess-1');
    expect(started).toHaveLength(1);
    expect(started[0].model).toBe('opus');
    expect(started[0].trusted).toBe(true);
    expect(started[0].prompt).toContain(NO_RENDER_RULE);
    expect(path.dirname(started[0].cwd)).toBe(path.resolve(videos));
    expect(fs.statSync(started[0].cwd).isDirectory()).toBe(true);
    expect(db.getClip('sess-1')).toMatchObject({ stage: 0, ready: false, styleName: OUR_STYLES[0].name });
  });

  it('a clip job starts in acceptEdits unless the command names another mode; remote control only when asked', () => {
    const { svc, started } = setup();
    svc.start(req());
    svc.start(req({ permissionMode: 'plan', remoteControl: true }));
    const got = started as unknown as { permissionMode?: string; remoteControl?: boolean }[];
    expect(got[0]).toMatchObject({ permissionMode: 'acceptEdits', remoteControl: false });
    expect(got[1]).toMatchObject({ permissionMode: 'plan', remoteControl: true });
  });

  it('picks a free folder name and refuses unknown or uninstalled styles', () => {
    const { svc, videos } = setup();
    fs.mkdirSync(path.join(videos, 'abc'));
    expect(freeFolderName(videos, 'abc')).toBe('abc-2');
    expect(() => svc.start(req({ styleId: 'lemo:art-deco' }))).toThrow(/Lemo/);
    expect(() => svc.start(req({ styleId: 'ours:nope' }))).toThrow();
    expect(() => svc.start(req({ voiceId: null }))).toThrow(/เสียง/);
  });

  it('never goes backwards; render is refused until พร้อม render, then sends only "render ได้" once', () => {
    const { svc, setSessions, sent, db, kill } = setup();
    svc.start(req());
    expect(() => svc.render('sess-1')).toThrow(/ยังไม่ถึง/);
    setSessions([sess([{ kind: 'text', text: 'ขั้น 3/5 สร้าง scene' }])]);
    svc.refresh();
    expect(db.getClip('sess-1')!.stage).toBe(2);
    setSessions([sess([])]); // old events scrolled away
    svc.refresh();
    expect(db.getClip('sess-1')!.stage).toBe(2);
    expect(() => svc.render('sess-1')).toThrow(/ยังไม่ถึง/);
    setSessions([sess([{ kind: 'text', text: 'ขั้น 5/5 พร้อม render' }])]);
    svc.refresh();
    expect(db.getClip('sess-1')).toMatchObject({ stage: 4, ready: true });
    svc.render('sess-1');
    expect(sent).toEqual([['sess-1', RENDER_MESSAGE]]);
    expect(RENDER_MESSAGE).toBe('render ได้');
    expect(() => svc.render('sess-1')).toThrow(/แล้ว/);
    expect(() => svc.render('other')).toThrow(/ไม่ใช่งานคลิป/);
    kill();
  });
});

describe('clip commands', () => {
  const good = { type: 'clip_start', reqId: 'r1', topic: 'x', points: '', settings: SETTINGS, styleId: 'ours:whiteboard', voiceId: 'KhBRXgEQjvfdIyXOu7G3', scriptModel: 'sonnet', builderModel: 'opus', effort: 'high' };
  it('accepts a good start and rejects bad fields', () => {
    expect(parseClientMsg(good).ok).toBe(true);
    expect(parseClientMsg({ ...good, topic: ' ' }).ok).toBe(false);
    expect(parseClientMsg({ ...good, styleId: '../x' }).ok).toBe(false);
    expect(parseClientMsg({ ...good, builderModel: 'haiku' }).ok).toBe(false);
    expect(parseClientMsg({ ...good, scriptModel: 'tokenme-qwen' }).ok).toBe(false);
    expect(parseClientMsg({ ...good, voiceId: 'a/b' }).ok).toBe(false);
    expect(parseClientMsg({ ...good, settings: { ...SETTINGS, cast: ['ใคร'] } }).ok).toBe(false);
    expect(parseClientMsg({ ...good, cwd: 'C:/evil' }).ok).toBe(true); // extra field is ignored, never used
    const m = parseClientMsg({ ...good, cwd: 'C:/evil' });
    expect(m.ok && 'cwd' in m.msg).toBe(false);
  });
  it('permission mode: validated, missing stays missing (the server picks acceptEdits), bypass needs confirm', () => {
    const mode = (m: unknown) => { const r = parseClientMsg(m); return r.ok ? (r.msg as { permissionMode?: string }).permissionMode : 'REJECTED'; };
    expect(mode(good)).toBeUndefined();
    expect(mode({ ...good, permissionMode: 'plan' })).toBe('plan');
    expect(mode({ ...good, permissionMode: 'auto' })).toBe('REJECTED');
    expect(mode({ ...good, permissionMode: 'bypassPermissions' })).toBe('REJECTED');
    expect(mode({ ...good, permissionMode: 'bypassPermissions', confirm: 'yes' })).toBe('REJECTED');
    expect(mode({ ...good, permissionMode: 'bypassPermissions', confirm: true })).toBe('bypassPermissions');
    expect(parseClientMsg({ ...good, remoteControl: 'on' }).ok).toBe(false);
  });
  it('clip_render needs a session id', () => {
    expect(parseClientMsg({ type: 'clip_render', reqId: 'r', sessionId: 's-1' }).ok).toBe(true);
    expect(parseClientMsg({ type: 'clip_render', reqId: 'r' }).ok).toBe(false);
  });
});

describe('loadOurStyles', () => {
  const dirs: string[] = [];
  const mk = (content?: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ours-'));
    dirs.push(d);
    if (content !== undefined) fs.writeFileSync(path.join(d, 'our-styles.json'), content);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const good = { id: 'a', name: 'A', note: 'n', sourceDir: 'C:/x', workflowFiles: ['AGENTS.md'], extraRules: [], renders: ['C:/x/r.mp4'], alt: 'alt' };

  it('a missing file gives an empty list', () => {
    expect(loadOurStyles(mk())).toEqual([]);
  });

  it('bad JSON or a non-array gives an empty list, never throws', () => {
    expect(loadOurStyles(mk('{not json'))).toEqual([]);
    expect(loadOurStyles(mk('{"id":"a"}'))).toEqual([]);
  });

  it('loads a valid file and skips invalid entries', () => {
    const d = mk(JSON.stringify([good, { id: 'b' }, null, { ...good, id: 'c', renders: 'x' }, { ...good, id: '' }, { ...good, id: 'd' }]));
    expect(loadOurStyles(d).map((s) => s.id)).toEqual(['a', 'd']);
    expect(loadOurStyles(d)[0]).toEqual(good);
  });
});
