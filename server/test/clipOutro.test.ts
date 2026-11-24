import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClipSettings, ClipStartInput } from '../../shared/protocol';
import { CLIP_OUTRO_MAX, CLIP_OUTRO_SAVED_MAX, cleanOutroText } from '../../shared/protocol';
import { buildClipPrompt, settingsLine } from '../src/clipPrompt';
import { ClipService } from '../src/clips';
import { parseClientMsg } from '../src/commands';
import { WorklogDb } from '../src/db';
import { ourStyleById } from '../src/ourStyles';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const S: ClipSettings = { length: '30s', ratio: '9:16', lang: 'th', voice: false, music: false, cast: ['เทค'] };
const base = { reqId: 'r1' };

function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-outro-'));
  tmp.push(d);
  const db = new WorklogDb(':memory:');
  const prompts: string[] = [];
  let n = 0;
  let ids = 0;
  const runner = { start: (r: { prompt: string }) => (prompts.push(r.prompt), `s-${++n}`), send: () => undefined, isAlive: () => true };
  const svc = new ClipService({ db, runner: runner as never, sessions: () => [], lemo: () => ({ installed: false, styles: [], categories: [] }), videosDir: d, newId: () => `id-${++ids}` });
  return { svc, db, prompts };
}
const req = (settings: ClipSettings): ClipStartInput => ({ topic: 'FRL', points: '', settings, styleId: 'ours:whiteboard', voiceId: null, scriptModel: 'sonnet', builderModel: 'opus', effort: 'high' });

describe('cleanOutroText', () => {
  it('strips control characters, keeps newlines, trims', () => {
    expect(cleanOutroText('  a\u0000b\u0007c\r\nd\re\tf\u001b  ')).toBe('abc\nd\nef');
  });
});

describe('saved endings', () => {
  it('saves with default name (first 20 chars), renames, deletes, and shows in the view', () => {
    const { svc } = setup();
    const id = svc.saveOutro({ text: 'กดติดตามช่องไว้ได้เลยนะครับ ขอบคุณที่ดูจนจบ' });
    let list = svc.view().outros;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, text: 'กดติดตามช่องไว้ได้เลยนะครับ ขอบคุณที่ดูจนจบ' });
    expect([...list[0].name].length).toBe(20);
    svc.saveOutro({ id, name: 'CTA', text: list[0].text });
    list = svc.view().outros;
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('CTA');
    svc.deleteOutro(id);
    expect(svc.view().outros).toEqual([]);
    expect(() => svc.deleteOutro(id)).toThrow();
  });
  it('emits change so every browser gets the new list', () => {
    const { svc } = setup();
    let n = 0;
    svc.on('change', () => n++);
    const id = svc.saveOutro({ text: 'x' });
    svc.deleteOutro(id);
    expect(n).toBe(2);
  });
  it('refuses empty, too long, unknown id and a 51st entry', () => {
    const { svc } = setup();
    expect(() => svc.saveOutro({ text: '  \u0000 ' })).toThrow();
    expect(() => svc.saveOutro({ text: 'x'.repeat(CLIP_OUTRO_MAX + 1) })).toThrow();
    expect(() => svc.saveOutro({ id: 'nope', text: 'x' })).toThrow();
    for (let i = 0; i < CLIP_OUTRO_SAVED_MAX; i++) svc.saveOutro({ text: `ending ${i}` });
    expect(() => svc.saveOutro({ text: 'one too many' })).toThrow(/50/);
    expect(svc.view().outros).toHaveLength(CLIP_OUTRO_SAVED_MAX);
  });
  it('is kept in SQLite', () => {
    const { db, svc } = setup();
    svc.saveOutro({ text: 'LINE @yourshop', name: 'LINE' });
    expect(db.listOutros().map((o) => o.name)).toEqual(['LINE']);
  });
});

describe('outro in commands', () => {
  it('validates clip_outro_save / clip_outro_delete', () => {
    expect(parseClientMsg({ ...base, type: 'clip_outro_save', text: ' hi\u0000 ', name: ' N ' })).toMatchObject({ ok: true, msg: { type: 'clip_outro_save', text: 'hi', name: 'N' } });
    expect(parseClientMsg({ ...base, type: 'clip_outro_save', text: '' }).ok).toBe(false);
    expect(parseClientMsg({ ...base, type: 'clip_outro_save', text: 'x'.repeat(301) }).ok).toBe(false);
    expect(parseClientMsg({ ...base, type: 'clip_outro_save', text: 'x'.repeat(300) }).ok).toBe(true);
    expect(parseClientMsg({ ...base, type: 'clip_outro_save', text: 'x', id: '../x' }).ok).toBe(false);
    expect(parseClientMsg({ ...base, type: 'clip_outro_save', text: 'x', name: 'n'.repeat(41) }).ok).toBe(false);
    expect(parseClientMsg({ ...base, type: 'clip_outro_delete', id: 'o-1' })).toMatchObject({ ok: true, msg: { id: 'o-1' } });
    expect(parseClientMsg({ ...base, type: 'clip_outro_delete', id: '' }).ok).toBe(false);
  });
  it('clip_start and clip_preset_save accept an outro, clean it, and refuse bad ones', () => {
    const start = { ...base, type: 'clip_start', topic: 'FRL', points: '', styleId: 'ours:whiteboard', voiceId: null, scriptModel: 'sonnet', builderModel: 'opus', effort: 'high' };
    const ok = parseClientMsg({ ...start, settings: { ...S, outro: { on: true, text: ' กดติดตาม\u0007 ' } } });
    expect(ok).toMatchObject({ ok: true, msg: { settings: { outro: { on: true, text: 'กดติดตาม' } } } });
    const old = parseClientMsg({ ...start, settings: S }) as { ok: boolean; msg: { settings: ClipSettings } };
    expect(old.ok).toBe(true);
    expect(old.msg.settings.outro).toBeUndefined();
    expect(parseClientMsg({ ...start, settings: { ...S, outro: { on: true, text: 'x'.repeat(301) } } }).ok).toBe(false);
    expect(parseClientMsg({ ...start, settings: { ...S, outro: { on: true, text: '   ' } } }).ok).toBe(false);
    expect(parseClientMsg({ ...start, settings: { ...S, outro: { on: 'yes', text: 'x' } } }).ok).toBe(false);
    expect(parseClientMsg({ ...start, settings: { ...S, outro: { on: false, text: '' } } }).ok).toBe(true);
    const ps = parseClientMsg({ ...base, type: 'clip_preset_save', name: 'P', styleId: 'ours:whiteboard', settings: { ...S, outro: { on: true, text: 'LINE' } } });
    expect(ps).toMatchObject({ ok: true, msg: { settings: { outro: { on: true, text: 'LINE' } } } });
  });
});

describe('preset with an outro', () => {
  it('is stored and read back; an old preset has none', () => {
    const { svc } = setup();
    const withId = svc.savePreset({ name: 'มีท้าย', settings: { ...S, outro: { on: true, text: 'กดติดตาม' } }, styleId: 'ours:whiteboard' });
    const oldId = svc.savePreset({ name: 'เก่า', settings: S, styleId: 'ours:whiteboard' });
    const ps = svc.view().presets;
    expect(ps.find((p) => p.id === withId)?.settings.outro).toEqual({ on: true, text: 'กดติดตาม' });
    expect(ps.find((p) => p.id === oldId)?.settings.outro).toBeUndefined();
  });
});

describe('outro in the prompt', () => {
  const style = { kind: 'ours' as const, style: ourStyleById('whiteboard')! };
  const prompt = (settings: ClipSettings, voiceId: string | null = null) => buildClipPrompt({ req: { ...req(settings), voiceId }, style, cwd: '/x/frl' });
  it('puts the final-scene instruction and the exact text in the brief', () => {
    const p = prompt({ ...S, outro: { on: true, text: 'กดติดตามไว้ได้เลย\nLINE: @yourshop' } });
    expect(p).toContain('## ท้ายคลิป (outro)');
    expect(p).toContain('ฉากสุดท้ายของคลิป (ยาวประมาณ 3-5 วินาที นับรวมอยู่ในความยาวที่เลือกแล้ว ไม่ต่อเพิ่ม)');
    expect(p).toContain('9:16 แนวตั้ง (1080x1920)');
    expect(p).toContain('> กดติดตามไว้ได้เลย\n> LINE: @yourshop');
    expect(p).toContain('ไม่มีเสียงพากย์: แสดงเป็นข้อความบนจอเท่านั้น');
    expect(settingsLine({ ...S, outro: { on: true, text: 'x' } })).toContain('มีฉากท้ายคลิป');
  });
  it('has the narrator read it when voice-over is on', () => {
    const p = prompt({ ...S, voice: true, outro: { on: true, text: 'กดติดตาม' } }, 'VOICE123');
    expect(p).toContain('ผู้พากย์อ่านข้อความท้ายคลิปนี้ด้วย (ภาษาไทย)');
  });
  it('adds nothing when the outro is off, empty or missing', () => {
    for (const settings of [S, { ...S, outro: { on: false, text: 'x' } }, { ...S, outro: { on: true, text: '  ' } }]) {
      expect(prompt(settings)).not.toContain('ท้ายคลิป');
    }
  });
  it('reaches the runner through a queued clip', () => {
    const { svc, prompts } = setup();
    svc.enqueue(req({ ...S, outro: { on: true, text: 'กดติดตามช่อง' } }));
    expect(prompts[0]).toContain('> กดติดตามช่อง');
  });
});
