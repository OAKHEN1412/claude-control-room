// Pure helpers of the Clip Studio page: ratio frames, presets, the "type a topic, press Enter" flow, queue lines.
// No React here so every rule can be tested without a browser.
import { CLIP_OUTRO_MAX, CLIP_OUTRO_SAVED_MAX, CLIP_STAGES, cleanOutroText, type ClipJob, type ClipOutro, type ClipOutroPhrase, type ClipPreset, type ClipQueueItem, type ClipSettings } from '../../shared/protocol';

export type Ratio = ClipSettings['ratio'];

export interface RatioInfo {
  ratio: Ratio;
  w: number; // proportion, e.g. 16
  h: number; // 9
  name: string; // "แนวนอน"
  platforms: string; // "YouTube · จอทีวี"
}

export const RATIO_INFO: Record<Ratio, RatioInfo> = {
  '16:9': { ratio: '16:9', w: 16, h: 9, name: 'แนวนอน', platforms: 'YouTube · จอทีวี' },
  '9:16': { ratio: '9:16', w: 9, h: 16, name: 'แนวตั้ง', platforms: 'TikTok · Reels · Shorts' },
  '1:1': { ratio: '1:1', w: 1, h: 1, name: 'จัตุรัส', platforms: 'Facebook · IG feed' },
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

export const LENGTH_LABEL: Record<ClipSettings['length'], string> = { '30s': '30 วิ', '60s': '60 วิ', '90s': '90 วิ', '3min': '3 นาที' };

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
  const t = o.on ? cleanOutroText(o.text).replace(/\s*\n\s*/g, ' / ') : '';
  if (t === '') return null;
  return `ท้ายคลิป: ${[...t].length > max ? `${[...t].slice(0, max).join('')}…` : t}`;
}

/** Default name of a saved ending: the first 20 characters of its text. */
export function outroDefaultName(text: string): string {
  return [...cleanOutroText(text).replace(/\s+/g, ' ')].slice(0, 20).join('');
}

/** Can the ending be saved / sent as typed? Returns the Thai reason when not. */
export function outroProblem(o: ClipOutro): string | null {
  const t = cleanOutroText(o.text);
  if ([...t].length > CLIP_OUTRO_MAX) return `ยาวเกิน ${CLIP_OUTRO_MAX} ตัวอักษร`;
  if (o.on && t === '') return 'เปิดท้ายคลิปแล้ว — พิมพ์ข้อความก่อน';
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
  return [LENGTH_LABEL[s.length], s.lang === 'th' ? 'ไทย' : 'English', s.voice ? 'เสียง' : 'ไม่มีเสียง', s.music ? 'เพลง' : 'ไม่มีเพลง', s.cast.length > 0 ? s.cast.join(' ') : 'ไม่มีตัวละคร', ...(outroOf(s).on ? ['มีท้ายคลิป'] : [])].join(' · ');
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

/** Generic status line of one started clip. `alive` = its Runner child is running (undefined = unknown). */
export function jobStatusLine(j: ClipJob, alive: boolean | undefined): { text: string; tone: 'ready' | 'done' | 'run' | 'stop' } {
  if (j.renderRequested) return { text: 'ส่งคำสั่ง "render ได้" แล้ว', tone: 'done' };
  if (j.ready) return { text: 'พร้อม render — รอคุณสั่ง', tone: 'ready' };
  if (alive === false) return { text: `หยุดทำงานที่ขั้น ${j.stage + 1}/5 ${CLIP_STAGES[j.stage]}`, tone: 'stop' };
  return { text: `กำลังทำ — ขั้น ${j.stage + 1}/5 ${CLIP_STAGES[j.stage]}`, tone: 'run' };
}

/** Queue entries first (oldest waiting at the top of the waiting block), then started clips newest first. */
export function queueStatusLine(q: ClipQueueItem, position: number): string {
  return q.error ? `เริ่มไม่ได้: ${q.error}` : `รอคิว — ลำดับที่ ${position}`;
}

/** Name suggestion for "+ บันทึกชุดใหม่", never one that already exists. */
export function suggestName(f: ClipForm, styleName: string | undefined, taken: string[]): string {
  const base = `${styleName ?? 'ชุดใหม่'} · ${ratioTitle(f.ratio)} · ${LENGTH_LABEL[f.length]}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} (${n})`)) return `${base} (${n})`;
}

/** Name of the preset a started clip matches (same settings and style), else a plain "style · ratio · length". */
export function clipSettingsLabel(presets: ClipPreset[], settings: ClipSettings, styleId: string, styleName: string): string {
  const hit = presets.find((p) => formMatchesPreset({ ...settings, style: styleId }, p));
  return hit ? hit.name : `${styleName} · ${ratioTitle(settings.ratio)} · ${LENGTH_LABEL[settings.length]}`;
}
