// Pure pan/zoom math for the canvas. The view maps world -> screen: screen = world * k + (x, y).
import type { Box, Point } from './canvasLayout';

export interface View {
  x: number;
  y: number;
  k: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 2.5;
export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Zooms by `factor` keeping the world point under screen point (px, py) fixed. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const k = clampZoom(v.k * factor);
  const f = k / v.k;
  return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
}

export function screenToWorld(v: View, p: Point): Point {
  return { x: (p.x - v.x) / v.k, y: (p.y - v.y) / v.k };
}

export interface FitOptions {
  pad?: number;
  /** Extra room kept free at the top / bottom (floating toolbars). */
  padTop?: number;
  padBottom?: number;
  /** Screen px at the right edge that floating widgets cover; the graph is fitted to the rest. */
  insetRight?: number;
  maxZoom?: number;
}

/** A view that shows all of `bounds` centred in the visible area. An empty box gives a neutral view. */
export function fitView(bounds: Box, size: { w: number; h: number }, opts: FitOptions = {}): View {
  const pad = opts.pad ?? 48;
  const availW = Math.max(1, size.w - (opts.insetRight ?? 0));
  if (bounds.w <= 0 || bounds.h <= 0) return { x: pad, y: pad, k: 1 };
  const top = pad + (opts.padTop ?? 0);
  const availH = Math.max(1, size.h - top - pad - (opts.padBottom ?? 0));
  const k = clampZoom(Math.min((availW - 2 * pad) / bounds.w, availH / bounds.h, opts.maxZoom ?? 1));
  return {
    k,
    x: (availW - bounds.w * k) / 2 - bounds.x * k,
    y: top + Math.max(0, (availH - bounds.h * k) / 2) - bounds.y * k,
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

/** A view between `a` and `b` (t in 0..1, eased). Zoom interpolates in log space so it feels even. */
export function tweenView(a: View, b: View, t: number): View {
  const e = ease(Math.min(1, Math.max(0, t)));
  return { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), k: Math.exp(lerp(Math.log(a.k), Math.log(b.k), e)) };
}

/** A view that centres `box` in the visible area, zoomed so it fills at most ~80% of it (never past `maxZoom`). */
export function viewForBox(box: Box, size: { w: number; h: number }, opts: { insetRight?: number; maxZoom?: number } = {}): View {
  const availW = Math.max(1, size.w - (opts.insetRight ?? 0));
  const k = clampZoom(Math.min((availW * 0.8) / box.w, (size.h * 0.8) / box.h, opts.maxZoom ?? 1));
  return { k, x: availW / 2 - (box.x + box.w / 2) * k, y: size.h / 2 - (box.y + box.h / 2) * k };
}
