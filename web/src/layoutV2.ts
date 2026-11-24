// Layout engine of UI v2: the canvas fills the screen and four widgets float over it.
// Geometry helpers (Rect, snap, move/resize, clamp) are shared with v1 (layout.ts); only the widget set,
// the presets, the hidden flags and the storage key differ. v1 keeps its own saved layout (cr-layout-v1).
import { clampRect, PRESET_NAMES, type PresetName, type Rect, type StorageLike } from './layout';

export type { Rect, StorageLike };

export type WidgetId2 = 'pane1' | 'pane2' | 'summary' | 'clip' | 'saved';
export const WIDGET_IDS2: readonly WidgetId2[] = ['pane1', 'pane2', 'summary', 'clip', 'saved'];
/** The widgets that still float over the canvas in v2. pane1 / pane2 are pane nodes on the canvas now (see canvas/paneStore.ts). */
export type FloatId2 = 'summary' | 'clip' | 'saved';
export const FLOAT_IDS2: readonly FloatId2[] = ['summary', 'clip', 'saved'];
export type Layout2 = Record<WidgetId2, Rect>;
export type HiddenMap = Record<WidgetId2, boolean>;

// Same preset names as v1, so the Header's layout picker works for both ('graph-big' = big canvas here).
export type PresetName2 = PresetName;
export const PRESET_NAMES2: readonly PresetName2[] = PRESET_NAMES;

export interface StoredLayout2 {
  preset: PresetName2 | 'custom';
  rects: Layout2;
  hidden: HiddenMap; // widgets the user hid; the dock shows them again
}

export const STORAGE_KEY_V2 = 'cr-layout-v2';

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

// Widgets float over the canvas. Every preset leaves the left part of the screen to the canvas.
// No two rects of a preset overlap, so showing every widget never stacks them.
export const PRESETS2: Record<PresetName2, Layout2> = {
  standard: {
    pane1: r(75, 0, 25, 50),
    pane2: r(75, 50, 25, 50),
    summary: r(25, 60, 25, 40),
    clip: r(25, 20, 25, 40),
    saved: r(50, 0, 25, 100),
  },
  'graph-big': {
    pane1: r(40, 0, 15, 20),
    pane2: r(55, 0, 15, 20),
    summary: r(40, 60, 30, 40),
    clip: r(40, 20, 30, 40),
    saved: r(70, 0, 30, 100),
  },
  'chat-big': {
    pane1: r(35, 0, 32.5, 50),
    pane2: r(35, 50, 32.5, 50),
    summary: r(0, 30, 35, 35),
    clip: r(0, 65, 35, 26),
    saved: r(67.5, 0, 32.5, 100),
  },
};

/** Widgets each preset starts hidden. */
export const PRESET_HIDDEN2: Record<PresetName2, readonly WidgetId2[]> = {
  standard: ['summary', 'clip', 'saved'], // collapsed: the dock brings them back
  'graph-big': ['summary', 'clip', 'saved'],
  'chat-big': ['summary', 'clip', 'saved'],
};

export const noneHidden = (): HiddenMap => ({ pane1: false, pane2: false, summary: false, clip: false, saved: false });

export function cloneLayout2(layout: Layout2): Layout2 {
  const out = {} as Layout2;
  for (const id of WIDGET_IDS2) out[id] = { ...layout[id] };
  return out;
}

export function applyPreset2(name: PresetName2): StoredLayout2 {
  const hidden = noneHidden();
  for (const id of PRESET_HIDDEN2[name]) hidden[id] = true;
  return { preset: name, rects: cloneLayout2(PRESETS2[name]), hidden };
}

/** Hides or shows one widget; the preset name stays (hiding is not a rearrangement). */
export function setHidden(state: StoredLayout2, id: WidgetId2, hidden: boolean): StoredLayout2 {
  return { ...state, hidden: { ...state.hidden, [id]: hidden } };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function isValidRect(v: unknown): v is Rect {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const nums = [o.x, o.y, o.w, o.h];
  return nums.every((n) => typeof n === 'number' && Number.isFinite(n)) && (o.w as number) > 0 && (o.h as number) > 0;
}

function validateStored(raw: unknown): StoredLayout2 | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.preset !== 'string' || !o.rects || typeof o.rects !== 'object') return null;
  const rects = o.rects as Record<string, unknown>;
  const out = {} as Layout2;
  for (const id of WIDGET_IDS2) {
    const rect = rects[id];
    // A layout saved before the "saved sessions" widget existed has no rect for it: use the standard spot.
    if (rect === undefined && id === 'saved') {
      out[id] = { ...PRESETS2.standard.saved };
      continue;
    }
    if (!isValidRect(rect)) return null;
    out[id] = clampRect({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  }
  const hidden = noneHidden();
  const rawHidden = o.hidden && typeof o.hidden === 'object' ? (o.hidden as Record<string, unknown>) : {};
  for (const id of WIDGET_IDS2) hidden[id] = id === 'saved' && rawHidden[id] === undefined ? true : rawHidden[id] === true;
  const known = (PRESET_NAMES2 as readonly string[]).includes(o.preset);
  return { preset: known ? (o.preset as PresetName2) : 'custom', rects: out, hidden };
}

/** Reads the saved v2 layout (the v1 key is never read). Any failure gives 'standard'. */
export function loadLayout2(storage: StorageLike | null = defaultStorage()): StoredLayout2 {
  const fallback = applyPreset2('standard');
  try {
    if (!storage) return fallback;
    const raw = storage.getItem(STORAGE_KEY_V2);
    if (raw === null) return fallback;
    return validateStored(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Persists the v2 layout. Returns false when storage is unavailable or refuses the write. */
export function saveLayout2(state: StoredLayout2, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY_V2, JSON.stringify({ preset: state.preset, rects: state.rects, hidden: state.hidden }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Percent of the board width, measured from the right, that the floating widgets (summary, clip) cover. The canvas fits its
 * graph into the rest. Only widgets on the right part of the screen count.
 */
export function coverRightPct(state: StoredLayout2): number {
  let minX = 100;
  for (const id of FLOAT_IDS2) {
    if (state.hidden[id]) continue;
    const r = state.rects[id];
    if (r.x >= 30) minX = Math.min(minX, r.x);
  }
  return 100 - minX;
}
