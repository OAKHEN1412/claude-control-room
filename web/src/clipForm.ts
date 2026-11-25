// Pure helpers of the Clip Studio page: ratio frames, presets, the "type a topic, press Enter" flow, queue lines.
// No React here so every rule can be tested without a browser.
import { CLIP_OUTRO_MAX, CLIP_OUTRO_SAVED_MAX, CLIP_STAGES, CLIP_STAGE_CODES, cleanOutroText, type ClipJob, type ClipOutro, type ClipOutroPhrase, type ClipPreset, type ClipQueueItem, type ClipSettings } from '../../shared/protocol';
import { t, type TKey } from './i18n';
import { serverCode } from './i18n/serverMsg';

export type Ratio = ClipSettings['ratio'];

export interface RatioInfo {
  ratio: Ratio;
  w: number; // proportion, e.g. 16
  h: number; // 9
  readonly name: string; // "แนวนอน", read in the current language
  readonly platforms: string; // "YouTube · จอทีวี", read in the current language
}

/** Labels are read on each access, so they follow the UI language. */
function ratioInfo(ratio: Ratio, w: number, h: number, nameKey: TKey, platformsKey: TKey): RatioInfo {
  return {
    ratio,
    w,
    h,
    get name() {
      return t(nameKey);
    },
    get platforms() {
      return t(platformsKey);
    },
  };
}

export const RATIO_INFO: Record<Ratio, RatioInfo> = {
  '16:9': ratioInfo('16:9', 16, 9, 'clip.form.ratio.landscape', 'clip.form.platforms.landscape'),
  '9:16': ratioInfo('9:16', 9, 16, 'clip.form.ratio.portrait', 'clip.form.platforms.portrait'),
  '1:1': ratioInfo('1:1', 1, 1, 'clip.form.ratio.square', 'clip.form.platforms.square'),
};

/** "แนวนอน 16:9" */
export function ratioTitle(r: Ratio): string {
  return `${RATIO_INFO[r].name} ${r}`;
}

/** Size in px of a frame in the true proportion of `ratio` whose longer side is `box`. */
export function ratioFrame(ratio: Ratio, box: number): { w: number; h: number } {
  const { w, h } = RATIO_INFO[ratio];
  const long = Math.max(w, h);
  return { w: Math.round((box * w) / long), h: Math.round((box * h) / long) };
}

const LENGTH_KEYS: Record<ClipSettings['length'], TKey> = {
  '30s': 'clip.form.len.30s',
  '60s': 'clip.form.len.60s',
  '90s': 'clip.form.len.90s',
  '3min': 'clip.form.len.3min',
};

/** "60 วิ" / "60 sec": a clip length as shown to the user. */
export function lengthLabel(len: ClipSettings['length']): string {
  return t(LENGTH_KEYS[len]);
}

/** Everything a preset stores, as the page holds it. */
export interface ClipForm extends ClipSettings {
  style: string; // style id 'ours:x' / 'lemo:x'
}

const NO_OUTRO: ClipOutro = { on: false, text: '' };

/** The ending of a settings object; old presets and jobs have none = off. */
export function outroOf(s: { outro?: ClipOutro }): ClipOutro {
  return s.outro ?? NO_OUTRO;
}

export function formSettings(f: ClipForm): ClipSettings {
  const o = outroOf(f);
  return { length: f.length, ratio: f.ratio, lang: f.lang, voice: f.voice, music: f.music, cast: [...f.cast], ...(o.on || o.text !== '' ? { outro: { on: o.on, text: o.text } } : {}) };
}

/** First line of the ending, cut for a list: "ท้ายคลิป: กดติดตาม…". Null when the clip has no ending. */
export function outroLine(s: { outro?: ClipOutro }, max = 60): string | null {
  const o = outroOf(s);
  const text = o.on ? cleanOutroText(o.text).replace(/\s*\n\s*/g, ' / ') : '';
  if (text === '') return null;
  return t('clip.form.outroLine', { text: [...text].length > max ? `${[...text].slice(0, max).join('')}…` : text });
}

/** Default name of a saved ending: the first 20 characters of its text. */
export function outroDefaultName(text: string): string {
  return [...cleanOutroText(text).replace(/\s+/g, ' ')].slice(0, 20).join('');
}

/** Can the ending be saved / sent as typed? Returns the reason (in the UI language) when not. */
export function outroProblem(o: ClipOutro): string | null {
  const text = cleanOutroText(o.text);
  if ([...text].length > CLIP_OUTRO_MAX) return t('clip.form.outroTooLong', { max: CLIP_OUTRO_MAX });
  if (o.on && text === '') return t('clip.form.outroEmpty');
  return null;
}

/** Room left in the saved list. */
export function outroSlotsLeft(saved: ClipOutroPhrase[]): number {
  return Math.max(0, CLIP_OUTRO_SAVED_MAX - saved.length);
}

/** Select a preset: every control takes the preset's values. Anything else on the form (voice id, models) stays. */
export function applyPreset<F extends ClipForm>(form: F, p: Pick<ClipPreset, 'settings' | 'styleId'>): F {
  const o = p.settings.outro;
  return { ...form, ...p.settings, cast: [...p.settings.cast], outro: o ? { ...o } : { on: false, text: outroOf(form).text }, style: p.styleId }; // an old preset has no ending: it switches it off and keeps the text typed so far
}

const sameCast = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/** Two endings are the same when both are off (the kept text does not matter) or both on with the same text. */
function sameOutro(a: ClipOutro, b: ClipOutro): boolean {
  return a.on === b.on && (!a.on || cleanOutroText(a.text) === cleanOutroText(b.text));
}

/** True when the form holds exactly the preset's values (cast order does not matter). */
export function formMatchesPreset(f: ClipForm, p: Pick<ClipPreset, 'settings' | 'styleId'>): boolean {
  const s = p.settings;
  return f.length === s.length && f.ratio === s.ratio && f.lang === s.lang && f.voice === s.voice && f.music === s.music && sameCast(f.cast, s.cast) && sameOutro(outroOf(f), outroOf(s)) && f.style === p.styleId;
}

/** "60 วิ · ไทย · เสียง · เพลง · เทค, บอท" */
export function settingsSummary(s: ClipSettings): string {
  return [
    lengthLabel(s.length),
    s.lang === 'th' ? t('clip.form.langTh') : t('clip.form.langEn'),
    s.voice ? t('clip.form.voice') : t('clip.form.noVoice'),
    s.music ? t('clip.form.music') : t('clip.form.musicOff'),
    s.cast.length > 0 ? s.cast.join(' ') : t('clip.form.noCast'),
    ...(outroOf(s).on ? [t('clip.form.hasOutro')] : []),
  ].join(' · ');
}

/** The topic form after a clip was queued: topic and points are cleared, every setting stays. */
export interface EntryState {
  topic: string;
  points: string;
}
export function afterQueued<T extends EntryState>(state: T): T {
  return { ...state, topic: '', points: '' };
}

/** Enter in the topic field queues the clip, unless an IME is composing (Thai/CJK) or Shift is held, or there is no topic. */
export function isQueueKey(e: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }, topic: string): boolean {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return false;
  return topic.trim() !== '';
}

/** Ready to render and not yet ordered: what "render ทุกอันที่พร้อม" acts on. */
export function readyJobs(jobs: ClipJob[]): ClipJob[] {
  return jobs.filter((j) => j.ready && !j.renderRequested);
}

/** Name of one pipeline stage (index into CLIP_STAGES, which is the shared stage order). */
export function stageLabel(i: number): string {
  const keys: TKey[] = ['clip.stage.script', 'clip.stage.storyboard', 'clip.stage.scenes', 'clip.stage.preview', 'clip.stage.ready'];
  const key = keys[i];
  const local = key ? t(key) : (CLIP_STAGES[i] ?? '');
  return serverCode(CLIP_STAGE_CODES[i], undefined, local);
}

/** Generic status line of one started clip. `alive` = its Runner child is running (undefined = unknown). */
export function jobStatusLine(j: ClipJob, alive: boolean | undefined): { text: string; tone: 'ready' | 'done' | 'run' | 'stop' } {
  if (j.renderRequested) return { text: t('clip.form.renderSent'), tone: 'done' };
  if (j.ready) return { text: t('clip.form.readyWait'), tone: 'ready' };
  if (alive === false) return { text: t('clip.form.stopped', { n: j.stage + 1, stage: stageLabel(j.stage) }), tone: 'stop' };
  return { text: t('clip.form.running', { n: j.stage + 1, stage: stageLabel(j.stage) }), tone: 'run' };
}

/** Queue entries first (oldest waiting at the top of the waiting block), then started clips newest first. */
export function queueStatusLine(q: ClipQueueItem, position: number): string {
  return q.error ? t('clip.form.startFailed', { error: q.error }) : t('clip.form.queued', { n: position });
}

/** Name suggestion for "+ บันทึกชุดใหม่", never one that already exists. */
export function suggestName(f: ClipForm, styleName: string | undefined, taken: string[]): string {
  const base = `${styleName ?? t('clip.form.newPreset')} · ${ratioTitle(f.ratio)} · ${lengthLabel(f.length)}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} (${n})`)) return `${base} (${n})`;
}

/** Name of the preset a started clip matches (same settings and style), else a plain "style · ratio · length". */
export function clipSettingsLabel(presets: ClipPreset[], settings: ClipSettings, styleId: string, styleName: string): string {
  const hit = presets.find((p) => formMatchesPreset({ ...settings, style: styleId }, p));
  return hit ? hit.name : `${styleName} · ${ratioTitle(settings.ratio)} · ${lengthLabel(settings.length)}`;
}
