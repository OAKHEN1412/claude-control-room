import { describe, expect, it } from 'vitest';
import type { ClipJob, ClipPreset } from '../../shared/protocol';
import { RATIO_INFO, clipSettingsLabel, afterQueued, applyPreset, formMatchesPreset, formSettings, isQueueKey, jobStatusLine, outroDefaultName, outroLine, outroOf, outroProblem, outroSlotsLeft, queueStatusLine, ratioFrame, readyJobs, settingsSummary, suggestName, type ClipForm } from './clipForm';

const FORM: ClipForm = { length: '60s', ratio: '16:9', lang: 'th', voice: true, music: true, cast: ['เทค', 'บอท'], style: 'ours:whiteboard' };
const PRESET: ClipPreset = {
  id: 'p1',
  name: 'PLC · TikTok แนวตั้ง 60 วิ',
  settings: { length: '60s', ratio: '9:16', lang: 'th', voice: false, music: false, cast: ['ภู'] },
  styleId: 'lemo:impasto',
  suggested: false,
  createdAt: 1,
};
const job = (over: Partial<ClipJob> = {}): ClipJob => ({
  sessionId: 's', topic: 't', slug: 't', cwd: '/x', styleId: 'ours:whiteboard', styleName: 'W', settings: FORM, voiceId: null, scriptModel: 'sonnet', builderModel: 'opus', createdAt: 1, stage: 1, ready: false, renderRequested: false, ...over,
});

describe('ratio frames', () => {
  it('draws each ratio in its true proportion inside the box', () => {
    expect(ratioFrame('16:9', 36)).toEqual({ w: 36, h: 20 });
    expect(ratioFrame('9:16', 36)).toEqual({ w: 20, h: 36 });
    expect(ratioFrame('1:1', 36)).toEqual({ w: 36, h: 36 });
  });
  it('vertical is taller than wide, horizontal wider than tall, for any box', () => {
    for (const box of [14, 16, 40, 64]) {
      expect(ratioFrame('9:16', box).h).toBeGreaterThan(ratioFrame('9:16', box).w);
      expect(ratioFrame('16:9', box).w).toBeGreaterThan(ratioFrame('16:9', box).h);
      expect(ratioFrame('1:1', box).w).toBe(ratioFrame('1:1', box).h);
    }
  });
  it('knows the platforms', () => {
    expect(RATIO_INFO['9:16'].platforms).toContain('TikTok');
    expect(RATIO_INFO['16:9'].platforms).toContain('YouTube');
  });
});

describe('presets', () => {
  it('applying a preset sets every control and keeps the rest of the form', () => {
    const f = applyPreset({ ...FORM, voiceId: 'abc' }, PRESET);
    expect(formSettings(f)).toEqual(PRESET.settings);
    expect(f.style).toBe('lemo:impasto');
    expect(f.voiceId).toBe('abc');
    f.cast.push('x');
    expect(PRESET.settings.cast).toEqual(['ภู']); // not shared
  });
  it('matches only when nothing differs (cast order ignored)', () => {
    const f = applyPreset(FORM, PRESET);
    expect(formMatchesPreset(f, PRESET)).toBe(true);
    expect(formMatchesPreset({ ...f, ratio: '1:1' }, PRESET)).toBe(false);
    expect(formMatchesPreset({ ...f, style: 'ours:voxel3d' }, PRESET)).toBe(false);
    const two = { ...PRESET, settings: { ...PRESET.settings, cast: ['เทค', 'บอท'] } };
    expect(formMatchesPreset({ ...applyPreset(FORM, two), cast: ['บอท', 'เทค'] }, two)).toBe(true);
  });
  it('summarises settings', () => {
    expect(settingsSummary(PRESET.settings)).toBe('60 วิ · ไทย · ไม่มีเสียง · ไม่มีเพลง · ภู');
  });
  it('suggests a free name', () => {
    expect(suggestName(FORM, 'Whiteboard', [])).toBe('Whiteboard · แนวนอน 16:9 · 60 วิ');
    expect(suggestName(FORM, 'Whiteboard', ['Whiteboard · แนวนอน 16:9 · 60 วิ'])).toBe('Whiteboard · แนวนอน 16:9 · 60 วิ (2)');
  });
});

describe('enter-to-queue flow', () => {
  it('clears topic and points, keeps every setting', () => {
    const before = { ...FORM, topic: 'FRL', points: 'a, b', voiceId: 'v' };
    const after = afterQueued(before);
    expect(after.topic).toBe('');
    expect(after.points).toBe('');
    expect({ ...after, topic: 'FRL', points: 'a, b' }).toEqual(before);
  });
  it('Enter queues with a topic; not while composing Thai, with Shift, or with an empty topic', () => {
    expect(isQueueKey({ key: 'Enter' }, 'FRL')).toBe(true);
    expect(isQueueKey({ key: 'Enter' }, '   ')).toBe(false);
    expect(isQueueKey({ key: 'Enter', isComposing: true }, 'ส')).toBe(false);
    expect(isQueueKey({ key: 'Enter', keyCode: 229 }, 'ส')).toBe(false);
    expect(isQueueKey({ key: 'Enter', shiftKey: true }, 'FRL')).toBe(false);
    expect(isQueueKey({ key: 'a' }, 'FRL')).toBe(false);
  });
});

describe('queue lines', () => {
  it('picks only ready clips that were not yet ordered', () => {
    const list = [job({ sessionId: 'a', ready: true, stage: 4 }), job({ sessionId: 'b', ready: true, stage: 4, renderRequested: true }), job({ sessionId: 'c' })];
    expect(readyJobs(list).map((j) => j.sessionId)).toEqual(['a']);
  });
  it('status line per state', () => {
    expect(jobStatusLine(job({ stage: 4, ready: true }), true)).toMatchObject({ tone: 'ready' });
    expect(jobStatusLine(job({ stage: 4, ready: true, renderRequested: true }), true)).toMatchObject({ tone: 'done' });
    expect(jobStatusLine(job({ stage: 1 }), true)).toEqual({ text: 'กำลังทำ — ขั้น 2/5 storyboard', tone: 'run' });
    expect(jobStatusLine(job({ stage: 2 }), false).tone).toBe('stop');
    expect(jobStatusLine(job({ stage: 2 }), undefined).tone).toBe('run');
  });
  it('waiting line shows the position or the error', () => {
    const q = { id: 'q', topic: 't', settings: FORM, styleId: 'ours:x', styleName: 'X', createdAt: 1 };
    expect(queueStatusLine(q, 2)).toBe('รอคิว — ลำดับที่ 2');
    expect(queueStatusLine({ ...q, error: 'boom' }, 1)).toBe('เริ่มไม่ได้: boom');
  });
});

describe('queue item label', () => {
  it('uses the preset name when the clip matches one, else the plain summary', () => {
    expect(clipSettingsLabel([PRESET], PRESET.settings, PRESET.styleId, 'Impasto')).toBe(PRESET.name);
    expect(clipSettingsLabel([PRESET], { ...PRESET.settings, length: '30s' }, PRESET.styleId, 'Impasto')).toBe('Impasto · แนวตั้ง 9:16 · 30 วิ');
    expect(clipSettingsLabel([], FORM, 'ours:whiteboard', 'Whiteboard')).toBe('Whiteboard · แนวนอน 16:9 · 60 วิ');
  });
});

describe('ending (outro)', () => {
  const ON = { on: true, text: 'กดติดตามไว้ได้เลย\nLINE: @yourshop' };
  it('an old preset (no outro) switches the ending off and keeps the typed text', () => {
    const f = applyPreset({ ...FORM, outro: ON }, PRESET);
    expect(f.outro).toEqual({ on: false, text: ON.text });
    expect(outroOf(PRESET.settings)).toEqual({ on: false, text: '' });
    expect(formMatchesPreset(f, PRESET)).toBe(true); // the kept text of an off ending is not a change
  });
  it('a preset with an outro restores it and a different text counts as modified', () => {
    const p: ClipPreset = { ...PRESET, settings: { ...PRESET.settings, outro: ON } };
    const f = applyPreset(FORM, p);
    expect(f.outro).toEqual(ON);
    expect(formSettings(f)).toEqual(p.settings);
    expect(formMatchesPreset(f, p)).toBe(true);
    expect(formMatchesPreset({ ...f, outro: { on: true, text: 'อื่น' } }, p)).toBe(false);
    expect(formMatchesPreset({ ...f, outro: { on: false, text: ON.text } }, p)).toBe(false);
  });
  it('form settings carry the outro only when it is on or has text', () => {
    expect(formSettings(FORM).outro).toBeUndefined();
    expect(formSettings({ ...FORM, outro: { on: false, text: 'x' } }).outro).toEqual({ on: false, text: 'x' });
  });
  it('shows a one-line summary only when on, cut when long', () => {
    expect(outroLine({ outro: ON })).toBe('ท้ายคลิป: กดติดตามไว้ได้เลย / LINE: @yourshop');
    expect(outroLine({ outro: { on: false, text: 'x' } })).toBeNull();
    expect(outroLine({})).toBeNull();
    expect(outroLine({ outro: { on: true, text: 'ก'.repeat(100) } }, 10)).toBe(`ท้ายคลิป: ${'ก'.repeat(10)}…`);
    expect(settingsSummary({ ...PRESET.settings, outro: ON })).toContain('มีท้ายคลิป');
  });
  it('default name is the first 20 characters; problems are caught', () => {
    expect([...outroDefaultName('a'.repeat(50))].length).toBe(20);
    expect(outroDefaultName('  hello\nworld  ')).toBe('hello world');
    expect(outroProblem({ on: true, text: '  ' })).not.toBeNull();
    expect(outroProblem({ on: false, text: '' })).toBeNull();
    expect(outroProblem({ on: true, text: 'x'.repeat(301) })).not.toBeNull();
    expect(outroProblem({ on: true, text: 'x'.repeat(300) })).toBeNull();
    expect(outroSlotsLeft(Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: 'n', text: 't', createdAt: i })))).toBe(0);
  });
});
