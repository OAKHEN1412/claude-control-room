// Semantic zoom: how much detail a node draws at a given zoom k, and how much labels are enlarged
// (in world units) so key text stays readable on screen when zoomed far out. Pure.

export type Lod = 'full' | 'mid' | 'compact';

/** k >= FULL_ZOOM: everything. COMPACT_ZOOM <= k < FULL_ZOOM: less chrome. k < COMPACT_ZOOM: titles, status and the last line only. */
export const FULL_ZOOM = 0.8;
export const COMPACT_ZOOM = 0.45;
/** Key labels never render smaller than this many screen px (until the cap below). */
export const MIN_LABEL_PX = 11;
/** The most a label is enlarged in world units; below this zoom labels simply shrink again. */
export const MAX_LABEL_SCALE = 5;
/** Font size the counter-scale is measured against (the common label size in world px). */
export const LABEL_BASE_PX = 13;

export function lodFor(k: number): Lod {
  if (k >= FULL_ZOOM) return 'full';
  if (k >= COMPACT_ZOOM) return 'mid';
  return 'compact';
}

/**
 * Multiplier for a label's world font size so it stays >= MIN_LABEL_PX on screen:
 * 1 at normal zoom, 11 / (k * base) when zoomed out, capped at MAX_LABEL_SCALE.
 */
export function labelScale(k: number, basePx = LABEL_BASE_PX): number {
  if (!(k > 0) || !(basePx > 0)) return 1;
  return Math.min(MAX_LABEL_SCALE, Math.max(1, MIN_LABEL_PX / (k * basePx)));
}

/** World font size of a label whose normal size is `basePx`: it grows as you zoom out, never shrinks below `basePx`. */
export function labelPx(k: number, basePx: number): number {
  return Math.round(basePx * labelScale(k, basePx) * 100) / 100;
}

/** Snap a view offset to whole device pixels so text is rasterised on the pixel grid once the gesture is over. */
export function snapToPixel(v: number, dpr: number): number {
  const d = dpr > 0 ? dpr : 1;
  return Math.round(v * d) / d;
}
