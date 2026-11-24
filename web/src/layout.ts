// Pure widget layout engine (no React). All geometry is in percent of the board (0..100).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type WidgetId = 'graph' | 'pane1' | 'pane2' | 'summary' | 'clip';
export const WIDGET_IDS: readonly WidgetId[] = ['graph', 'pane1', 'pane2', 'summary', 'clip'];
export type Layout = Record<WidgetId, Rect>;

export type PresetName = 'standard' | 'graph-big' | 'chat-big';
export const PRESET_NAMES: readonly PresetName[] = ['standard', 'graph-big', 'chat-big'];

/** Stored preset value; 'custom' means the user has dragged/resized widgets by hand. */
export interface StoredLayout {
  preset: PresetName | 'custom';
  rects: Layout;
}

export const SNAP = 2.5;
export const MIN_SIZE = { w: 10, h: 10 };
export const STORAGE_KEY = 'cr-layout-v1';

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

// Geometry copied from the approved mockup (Main.dc.html defaults/presets), mapped to widget ids:
// graph -> graph, p0 -> pane1, p1 -> pane2, clips -> clip, side -> summary.
export const PRESETS: Record<PresetName, Layout> = {
  standard: {
    graph: r(0, 0, 50, 70),
    clip: r(0, 70, 25, 30),
    summary: r(25, 70, 25, 30),
    pane1: r(50, 0, 25, 100),
    pane2: r(75, 0, 25, 100),
  },
  'graph-big': {
    graph: r(0, 0, 65, 75),
    clip: r(0, 75, 32.5, 25),
    summary: r(32.5, 75, 32.5, 25),
    pane1: r(65, 0, 35, 50),
    pane2: r(65, 50, 35, 50),
  },
  'chat-big': {
    graph: r(0, 0, 35, 55),
    clip: r(0, 55, 35, 22.5),
    summary: r(0, 77.5, 35, 22.5),
    pane1: r(35, 0, 32.5, 100),
    pane2: r(67.5, 0, 32.5, 100),
  },
};

export const snap = (v: number): number => Math.round(v / SNAP) * SNAP;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Keeps the rect inside the 0..100 canvas and at least `min` in size. Does not snap. */
export function clampRect(rect: Rect, min: { w: number; h: number } = MIN_SIZE): Rect {
  const w = clamp(rect.w, min.w, 100);
  const h = clamp(rect.h, min.h, 100);
  return { x: clamp(rect.x, 0, 100 - w), y: clamp(rect.y, 0, 100 - h), w, h };
}

/** Moves by percent deltas; the result lands on the snap grid and stays on the canvas. */
export function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return clampRect({ ...rect, x: snap(rect.x + dx), y: snap(rect.y + dy) });
}

/** Resizes from the bottom-right corner; the top-left corner stays put. */
export function resizeRect(rect: Rect, dw: number, dh: number): Rect {
  const x = Math.min(rect.x, 100 - MIN_SIZE.w);
  const y = Math.min(rect.y, 100 - MIN_SIZE.h);
  const w = clamp(snap(rect.w + dw), MIN_SIZE.w, 100 - x);
  const h = clamp(snap(rect.h + dh), MIN_SIZE.h, 100 - y);
  return { x, y, w, h };
}

export function cloneLayout(layout: Layout): Layout {
  const out = {} as Layout;
  for (const id of WIDGET_IDS) out[id] = { ...layout[id] };
  return out;
}

export function applyPreset(name: PresetName): StoredLayout {
  return { preset: name, rects: cloneLayout(PRESETS[name]) };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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

/** Returns a valid StoredLayout for an unknown parsed value, or null when the shape is wrong. */
function validateStored(raw: unknown): StoredLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.preset !== 'string' || !o.rects || typeof o.rects !== 'object') return null;
  const rects = o.rects as Record<string, unknown>;
  const out = {} as Layout;
  for (const id of WIDGET_IDS) {
    const rect = rects[id];
    if (!isValidRect(rect)) return null;
    out[id] = clampRect({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  }
  const known = (PRESET_NAMES as readonly string[]).includes(o.preset);
  return { preset: known ? (o.preset as PresetName) : 'custom', rects: out };
}

/** Reads the saved layout. Any failure (no storage, bad JSON, bad shape, throwing storage) gives 'standard'. */
export function loadLayout(storage: StorageLike | null = defaultStorage()): StoredLayout {
  const fallback = applyPreset('standard');
  try {
    if (!storage) return fallback;
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    return validateStored(JSON.parse(raw)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Persists the layout. Returns false when storage is unavailable or refuses the write. */
export function saveLayout(state: StoredLayout, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify({ preset: state.preset, rects: state.rects }));
    return true;
  } catch {
    return false;
  }
}
