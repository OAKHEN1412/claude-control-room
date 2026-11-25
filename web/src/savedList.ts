// "งานที่บันทึกไว้": filtering, grouping by day and the actions each row offers. Pure.
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_LEVELS, type EffortLevel } from '../../shared/protocol';
import { modelOptionId } from './control';
import { getLanguage, t } from './i18n';
import type { SavedSession } from './protocolNext';
import { monthAbbr } from './summaryView';

export type SavedTab = 'all' | 'trash';

/** Source label of a row: terminal / web / clip (Thai: เว็บ, คลิป). */
export const sourceWord = (source: SavedSession['source']): string =>
  t(source === 'terminal' ? 'panels.savedList.sourceTerminal' : source === 'web' ? 'panels.savedList.sourceWeb' : 'panels.savedList.sourceClip');
export const liveResumeReason = (): string => t('panels.savedList.liveResume');

const startOfDay = (ts: number): number => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** วันนี้ / เมื่อวาน / "12 พ.ย." (with the Buddhist-era year when it is not this year). */
export function dayLabel(ts: number, now: number): string {
  const today = startOfDay(now);
  const day = startOfDay(ts);
  const diff = Math.round((today - day) / 86_400_000);
  if (diff === 0) return t('panels.savedList.today');
  if (diff === 1) return t('panels.savedList.yesterday');
  const d = new Date(ts);
  const base = `${d.getDate()} ${monthAbbr(d.getMonth())}`;
  if (d.getFullYear() === new Date(now).getFullYear()) return base;
  // Thai UI shows the Buddhist-era year; English shows the Gregorian one.
  return `${base} ${d.getFullYear() + (getLanguage() === 'th' ? 543 : 0)}`;
}

/** Clock time of the last activity, "14:05". */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Rows of one tab, newest activity first, narrowed by every word of the search text (title, folder, model, source). */
export function filterSaved(list: readonly SavedSession[], tab: SavedTab, query: string): SavedSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = list.filter((s) => (tab === 'trash' ? s.hidden : !s.hidden));
  const matched =
    words.length === 0
      ? rows
      : rows.filter((s) => {
          const hay = `${s.title} ${s.cwd} ${s.model ?? ''} ${s.effort ?? ''} ${sourceWord(s.source)} ${s.source}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
  return [...matched].sort((a, b) => b.lastActivity - a.lastActivity);
}

export interface SavedGroup {
  key: string;
  label: string;
  items: SavedSession[];
}

/** Groups rows (already sorted newest first) by the local day of their last activity. */
export function groupByDay(rows: readonly SavedSession[], now: number): SavedGroup[] {
  const out: SavedGroup[] = [];
  for (const s of rows) {
    const key = String(startOfDay(s.lastActivity));
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(s);
    else out.push({ key, label: dayLabel(s.lastActivity, now), items: [s] });
  }
  return out;
}

export interface RowActions {
  /** What the main button does. */
  primary: 'resume' | 'goto' | 'restore';
  primaryLabel: string;
  /** Why the main button is disabled (null = enabled). */
  primaryDisabled: string | null;
  /** The "ลบ" button (not shown in the trash tab). */
  canDelete: boolean;
}

/**
 * Actions of one row. A live session cannot be resumed: its button becomes "ไปที่บล็อก" (flies to the node), which is
 * disabled only when no node for it is on the canvas. In the trash the only action is "กู้คืน".
 */
export function rowActions(s: SavedSession, tab: SavedTab, onCanvas: (sessionId: string) => boolean): RowActions {
  if (tab === 'trash') return { primary: 'restore', primaryLabel: t('panels.savedList.restore'), primaryDisabled: null, canDelete: false };
  if (s.live) {
    return {
      primary: 'goto',
      primaryLabel: t('panels.savedList.goto'),
      primaryDisabled: onCanvas(s.sessionId) ? null : t('panels.savedList.noBlock'),
      canDelete: true,
    };
  }
  return { primary: 'resume', primaryLabel: t('panels.savedList.resume'), primaryDisabled: null, canDelete: true };
}

/** Starting values of the resume form, taken from the saved row (unknown model / effort fall back to the defaults). */
export function resumeDefaults(s: Pick<SavedSession, 'model' | 'effort'>): { model: string; effort: EffortLevel } {
  const effort = (EFFORT_LEVELS as readonly string[]).includes(s.effort ?? '') ? (s.effort as EffortLevel) : DEFAULT_EFFORT;
  return { model: modelOptionId(s.model) ?? DEFAULT_MODEL, effort };
}

export const countTab = (list: readonly SavedSession[], tab: SavedTab): number => list.filter((s) => (tab === 'trash' ? s.hidden : !s.hidden)).length;

/** Rows shown per page; the widget adds this many each time "แสดงเพิ่ม" is pressed (the real list holds hundreds). */
export const SAVED_PAGE = 50;

/** The first `limit` rows of the groups (whole groups, the last one cut); empty groups are dropped. */
export function limitGroups(groups: readonly SavedGroup[], limit: number): SavedGroup[] {
  const out: SavedGroup[] = [];
  let left = Math.max(0, limit);
  for (const g of groups) {
    if (left <= 0) break;
    const items = g.items.slice(0, left);
    left -= items.length;
    out.push({ ...g, items });
  }
  return out;
}
