import { describe, expect, it } from 'vitest';
import type { ClipSettings, ClipStartInput } from '../../shared/protocol';
import { NO_RENDER_RULE, buildClipPrompt } from '../src/clipPrompt';
import { NO_RENDER_RULE_EN, buildClipPromptEn, settingsLineEn } from '../src/clipPromptEn';
import type { OurStyle } from '../src/ourStyles';
import type { LemoStyle } from '../src/styles';

const THAI = /[\u0e00-\u0e7f]/;
// Thai literals that the English brief keeps on purpose: the progress marker, the stop phrase (both read by
// clipProgress.ts) and the go-ahead message the server sends. Cast names are Thai constants, listed separately.
const KEPT_THAI_LITERALS = ['ขั้น', 'พร้อม render', 'render ได้'];
const CAST_THAI = ['เทค', 'บอท', 'ภู', 'ฟ้า'];

// ASCII-only fixtures, so any Thai in the output must come from the markers above or from interpolated user data.
const ours: OurStyle = {
  id: 'demo',
  name: 'Demo style',
  note: 'demo note',
  sourceDir: 'C:/src/demo',
  workflowFiles: ['workflow', 'STYLE.md'],
  extraRules: ['keep scenes short'],
  renders: [],
  alt: '',
};
const guide: OurStyle = { ...ours, id: 'guide', noSubagents: true };
const lemo: LemoStyle = { id: 'art-deco', name: 'Art Deco', category: 'Graphic & Type', stylePath: 'C:/l/art-deco', thumb: null };

const BASE: ClipSettings = { length: '30s', ratio: '9:16', lang: 'en', voice: false, music: false, cast: [] };

function req(over: Partial<ClipStartInput> = {}): ClipStartInput {
  return {
    topic: 'What is an FRL unit',
    points: 'meaning, example',
    settings: BASE,
    styleId: 'ours:demo',
    voiceId: null,
    scriptModel: 'sonnet',
    builderModel: 'opus',
    effort: 'high',
    ...over,
  };
}

function thaiLeftovers(text: string): string[] {
  let t = text;
  for (const lit of KEPT_THAI_LITERALS) t = t.split(lit).join(' ');
  return t.match(/[\u0e00-\u0e7f]+/g) ?? [];
}

describe('English clip brief', () => {
  it('is chosen by settings.lang and the Thai brief is not used for it', () => {
    const en = buildClipPrompt({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(en).toBe(buildClipPromptEn({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' }));
    expect(en).toContain('You are making a video clip with HyperFrames');
  });

  it('carries the no-render rule with the same strength', () => {
    const en = buildClipPrompt({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(en).toContain(NO_RENDER_RULE_EN);
    expect(NO_RENDER_RULE_EN).toMatch(/do NOT render/);
    expect(NO_RENDER_RULE_EN).toContain('until the user orders it');
    const lemoBrief = buildClipPrompt({ req: req({ styleId: 'lemo:art-deco' }), style: { kind: 'lemo', style: lemo }, cwd: 'C:/v/x' });
    expect(lemoBrief).toContain(NO_RENDER_RULE_EN);
  });

  it('gets the ElevenLabs key from the environment variable, never from secrets get', () => {
    const p = buildClipPrompt({ req: req({ settings: { ...BASE, voice: true }, voiceId: 'VOICE123' }), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(p).toContain('ELEVENLABS_API_KEY');
    expect(p).not.toContain('secrets get');
    expect(p).toContain('VOICE123');
    expect(p).toContain('eleven_v3');
  });

  it('has no Thai outside the kept markers when the user input is ASCII and no cast is set', () => {
    for (const style of [{ kind: 'ours' as const, style: ours }, { kind: 'ours' as const, style: guide }, { kind: 'lemo' as const, style: lemo }]) {
      const p = buildClipPrompt({ req: req({ settings: { ...BASE, voice: true, music: true, outro: { on: true, text: 'Follow us' } }, voiceId: 'VOICE123' }), style, cwd: 'C:/v/x' });
      expect(thaiLeftovers(p)).toEqual([]);
      expect(THAI.test(p.replace(new RegExp(KEPT_THAI_LITERALS.join('|'), 'g'), ''))).toBe(false);
    }
  });

  it('keeps the progress marker and the stop phrase the web UI matches', () => {
    const p = buildClipPrompt({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(p).toContain('`ขั้น N/5 <step name>`');
    expect(p).toContain('`ขั้น 5/5 พร้อม render`');
    expect(p).toContain('"render ได้"');
  });

  it('lists the steps in order and the report format', () => {
    const p = buildClipPrompt({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    const order = ['1 script', '2 storyboard', '3 build scenes', '4 preview', '5 ready to render'].map((s) => p.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('states the settings in English and the cast names, which are Thai constants', () => {
    const p = buildClipPrompt({ req: req({ settings: { ...BASE, cast: ['เทค', 'บอท'] } }), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(p).toContain('Settings: length 30 seconds · ratio 9:16 vertical (1080x1920) · language English');
    expect(p).toContain('cast เทค, บอท');
    // Thai appears only as the kept markers and the cast names.
    let t = p;
    for (const c of CAST_THAI) t = t.split(c).join(' ');
    expect(thaiLeftovers(t)).toEqual([]);
    expect(settingsLineEn({ ...BASE, cast: [] })).toContain('cast none');
  });

  it('drops ElevenLabs and does not call it when voice is off', () => {
    const p = buildClipPrompt({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(p).toContain('No voice-over');
    expect(p).toContain('do not call ElevenLabs');
    expect(p).not.toContain('ELEVENLABS_API_KEY');
  });

  it('puts the ending text in the brief exactly, with the final-scene instruction', () => {
    const p = buildClipPrompt({ req: req({ settings: { ...BASE, voice: true, outro: { on: true, text: 'Follow us\nLINE: @shop' } }, voiceId: 'V1' }), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(p).toContain('## Ending (outro)');
    expect(p).toContain('> Follow us\n> LINE: @shop');
    expect(p).toContain('The narrator also reads this ending text (English)');
    expect(p).toContain('9:16 vertical (1080x1920)');
  });

  it('keeps a Thai ending text as typed user input', () => {
    const p = buildClipPrompt({ req: req({ settings: { ...BASE, outro: { on: true, text: 'กดติดตามช่องนี้' } } }), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(p).toContain('> กดติดตามช่องนี้');
    expect(p).not.toContain('ท้ายคลิป');
  });

  it('forbids subagents for the guide style and names the subagent model otherwise', () => {
    expect(buildClipPrompt({ req: req(), style: { kind: 'ours', style: guide }, cwd: 'C:/v/x' })).toContain('must not use subagents');
    const split = buildClipPrompt({ req: req(), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(split).toContain('Agent tool, model: "sonnet"');
    expect(split).toContain('model opus');
  });

  it('names the lemo-opuscar skill and the style id for a Lemo style', () => {
    const p = buildClipPrompt({ req: req({ styleId: 'lemo:art-deco' }), style: { kind: 'lemo', style: lemo }, cwd: 'C:/v/x' });
    expect(p).toContain('lemo-opuscar');
    expect(p).toContain('style id: art-deco');
    expect(p).toContain('C:/l/art-deco');
  });
});

describe('Thai clip brief stays as it was', () => {
  it('still uses the Thai text for lang th', () => {
    const th = buildClipPrompt({ req: req({ settings: { ...BASE, lang: 'th' } }), style: { kind: 'ours', style: ours }, cwd: 'C:/v/x' });
    expect(th.startsWith('คุณกำลังทำคลิปวิดีโอด้วย HyperFrames (HTML เป็นวิดีโอ) ตาม workflow คลิปเดิมของเรา.')).toBe(true);
    expect(th).toContain(NO_RENDER_RULE);
    expect(th).not.toContain(NO_RENDER_RULE_EN);
    expect(th).not.toContain('You are making a video clip');
    expect(th).toContain('ค่าปรับ: ความยาว 30 วินาที · สัดส่วน 9:16 แนวตั้ง (1080x1920) · ภาษา ไทย');
  });
});
