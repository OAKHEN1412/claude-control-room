// Multi-monitor support: the launcher (scripts/open-wide.ps1) opens one window across several monitors and passes the
// client-x of every monitor boundary ("seam") in the URL (?seams=1920 or ?seams=1920,3840). Pure maths, no DOM.
import type { Box, Point } from './canvasLayout';
import { findFreeSpot } from './paneStore';
import type { View } from './viewport';

/** Half-width (screen px) of the keep-clear band on each side of a seam, for new panes. */
export const SEAM_BAND = 24;
/** Gap kept between a nudged popup / widget and a seam. */
export const SEAM_MARGIN = 16;

export interface Span {
  x: number;
  w: number;
}

/** The seams of a query string ("?seams=1920,3840"): integers strictly inside the window, sorted, unique. Others are dropped. */
export function parseSeams(search: string, width: number): number[] {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get('seams');
  } catch {
    return [];
  }
  if (!raw || !(width > 0)) return [];
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!/^\d{1,6}$/.test(t)) continue;
    const n = Number(t);
    if (n > 0 && n < width) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** The monitor spans (client x / width) the seams cut a window of `width` into. No seams: one span. */
export function monitorSpans(seams: readonly number[], width: number): Span[] {
  const edges = [0, ...seams.filter((s) => s > 0 && s < width), width];
  const out: Span[] = [];
  for (let i = 0; i < edges.length - 1; i++) out.push({ x: edges[i], w: edges[i + 1] - edges[i] });
  return out;
}

/** Index of the monitor holding client x (clamped to the first / last). */
export function monitorAt(spans: readonly Span[], x: number): number {
  for (let i = 0; i < spans.length; i++) if (x < spans[i].x + spans[i].w) return i;
  return Math.max(0, spans.length - 1);
}

/** Screen inset (px from the right edge) that leaves only the left-most monitor for "fit". 0 without seams. */
export function leftMonitorInset(seams: readonly number[], width: number): number {
  return seams.length > 0 ? Math.max(0, width - seams[0]) : 0;
}

/** Keep-clear bands around the seams, in world coordinates of `view` (full height). */
export function seamBandsWorld(seams: readonly number[], view: View, band = SEAM_BAND): Box[] {
  const big = 1e7;
  return seams.map((s) => ({ x: (s - band - view.x) / view.k, y: -big, w: (2 * band) / view.k, h: 2 * big }));
}

/** World point at the top-left of the last monitor's usable area (where new work panes start). */
export function lastMonitorStart(seams: readonly number[], view: View, top = 64): Point {
  const sx = (seams.length > 0 ? seams[seams.length - 1] : 0) + SEAM_BAND + SEAM_MARGIN;
  return { x: (sx - view.x) / view.k, y: (top - view.y) / view.k };
}

const crosses = (x: number, w: number, bands: readonly Box[]): boolean => bands.some((b) => x < b.x + b.w && b.x < x + w);

/**
 * paneStore.findFreeSpot that also keeps the box off the seam bands: tries `start.x`, then the columns just left /
 * right of each band, nearest first. Falls back to the plain search when nothing fits (a pane wider than a monitor).
 */
export function findFreeSpotAvoiding(size: { w: number; h: number }, start: Point, obstacles: readonly Box[], bands: readonly Box[]): Point {
  if (bands.length === 0) return findFreeSpot(size, start, obstacles);
  const xs = [start.x, ...bands.flatMap((b) => [b.x + b.w, b.x - size.w])]
    .filter((x) => !crosses(x, size.w, bands))
    .sort((a, b) => Math.abs(a - start.x) - Math.abs(b - start.x));
  for (const x of xs) {
    const spot = findFreeSpot(size, { x, y: start.y }, obstacles);
    if (spot.x === x) return spot;
  }
  return findFreeSpot(size, start, obstacles);
}

/**
 * Centre x (px) for a popup of `width` px so it does not straddle a seam: when its span comes within SEAM_MARGIN of a
 * seam it moves to the side of the monitor that holds `centre`, clamped inside that monitor. Unchanged without seams.
 */
export function nudgeCentre(centre: number, width: number, seams: readonly number[], windowWidth: number): number {
  if (seams.length === 0) return centre;
  const spans = monitorSpans(seams, windowWidth);
  const lo = centre - width / 2;
  const hi = centre + width / 2;
  if (!seams.some((s) => lo < s + SEAM_MARGIN && s - SEAM_MARGIN < hi)) return centre;
  const m = spans[monitorAt(spans, centre)];
  if (width + 2 * SEAM_MARGIN > m.w) return centre;
  return Math.min(m.x + m.w - SEAM_MARGIN - width / 2, Math.max(m.x + SEAM_MARGIN + width / 2, centre));
}

/** A percent rect (of a window `width` px wide) moved / shrunk onto the monitor it overlaps most when it crosses a seam. */
export function snapRectToMonitor<R extends { x: number; w: number }>(rect: R, seams: readonly number[], width: number): R {
  if (seams.length === 0 || width <= 0) return rect;
  const x0 = (rect.x / 100) * width;
  const x1 = x0 + (rect.w / 100) * width;
  if (!seams.some((s) => x0 < s && s < x1)) return rect;
  const spans = monitorSpans(seams, width);
  let best = spans[0];
  let bestOv = -1;
  for (const m of spans) {
    const ov = Math.min(x1, m.x + m.w) - Math.max(x0, m.x);
    if (ov > bestOv) {
      bestOv = ov;
      best = m;
    }
  }
  const lo = best.x + SEAM_MARGIN;
  const hi = best.x + best.w - SEAM_MARGIN;
  const w = Math.min(x1 - x0, hi - lo);
  const x = Math.min(hi - w, Math.max(lo, x0));
  return { ...rect, x: (x / width) * 100, w: (w / width) * 100 };
}
