// Relay links between AI blocks (session -> session): bezier geometry, the chip label / tone for each link state,
// the actions its menu offers, and detection of fresh forwards (for the 1.5 s flow animation). Pure.
import type { LinkInfo } from '../../../shared/protocol';
import type { CanvasLayout, Point } from './canvasLayout';
import { t } from '../i18n';
import { serverText } from '../i18n/serverMsg';

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Control points of the two curves of an A <-> B pair are pushed this far apart (perpendicular to the wire). */
export const LINK_OFFSET = 26;
export const MAX_FORWARDS_MIN = 1;
export const MAX_FORWARDS_MAX = 50;
export const FORWARD_PULSE_MS = 1500;
const ERR_CHARS = 30;

export interface LinkEnds {
  from: Point;
  to: Point;
  /**
   * The target is not clearly to the right of the source (cards stacked in one column): the wire then makes a "C" on the
   * right side and enters the target's right edge, instead of looping across both cards.
   */
  side: boolean;
}

/** The target must start at least this far right of the source's output port for the normal left-to-right wire. */
export const SIDE_LOOP_GAP = 60;
/** Bulge of a side loop (px right of the cards), plus a little per px of vertical distance. */
export const SIDE_BULGE = 56;
/** Where a side loop lands on the target's right edge (fraction of its height: above the "+" button at the middle). */
const SIDE_ENTRY = 0.22;

/** A link leaves the output port (right middle of the source card) and enters the input port (left middle of the target card). */
export function linkEnds(layout: CanvasLayout, link: Pick<LinkInfo, 'from' | 'to'>): LinkEnds | null {
  const a = layout.sessions.find((s) => s.sessionId === link.from);
  const b = layout.sessions.find((s) => s.sessionId === link.to);
  if (!a || !b) return null;
  const from = { x: a.card.x + a.card.w, y: a.card.y + a.card.h / 2 };
  const side = b.card.x < from.x + SIDE_LOOP_GAP;
  const to = side ? { x: b.card.x + b.card.w, y: b.card.y + b.card.h * SIDE_ENTRY } : { x: b.card.x, y: b.card.y + b.card.h / 2 };
  return { from, to, side };
}

/**
 * Sideways shift of a link's curve. 0 when no link runs the other way; otherwise +/- LINK_OFFSET, the sign fixed by
 * the id order, so A->B and B->A always land on opposite sides.
 */
export function linkOffset(link: Pick<LinkInfo, 'from' | 'to'>, all: readonly Pick<LinkInfo, 'from' | 'to'>[]): number {
  const reciprocal = all.some((o) => o.from === link.to && o.to === link.from);
  if (!reciprocal) return 0;
  return link.from < link.to ? LINK_OFFSET : -LINK_OFFSET;
}

/** Cubic bezier a -> b with horizontal tangents; `off` moves both control points sideways (y). */
export function bezier(a: Point, b: Point, c1: Point, c2: Point, t = 0.5): { d: string; mid: Point } {
  const u = 1 - t;
  const at = (k: 'x' | 'y') => u * u * u * a[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * b[k];
  return {
    d: `M ${r2(a.x)} ${r2(a.y)} C ${r2(c1.x)} ${r2(c1.y)}, ${r2(c2.x)} ${r2(c2.y)}, ${r2(b.x)} ${r2(b.y)}`,
    mid: { x: r2(at('x')), y: r2(at('y')) },
  };
}

/** Where the chip of a link sits along its curve: the middle, or 25 % along (next to its own source) for the two links of an A <-> B pair, so their chips end up apart. */
export const chipT = (offset: number): number => (offset !== 0 ? 0.25 : 0.5);

export function linkCurve(a: Point, b: Point, off = 0, t = 0.5): { d: string; mid: Point } {
  const dx = Math.max(80, Math.abs(b.x - a.x) * 0.5);
  return bezier(a, b, { x: a.x + dx, y: a.y + off }, { x: b.x - dx, y: b.y + off }, t);
}

/** "C" on the right of a column of cards: out of the output port, round, into the right edge of the target. `extra` nests a second wire outside it. */
export function sideCurve(a: Point, b: Point, extra = 0, t = 0.5): { d: string; mid: Point } {
  const bulge = SIDE_BULGE + Math.abs(b.y - a.y) * 0.18 + extra;
  return bezier(a, b, { x: a.x + bulge, y: a.y }, { x: b.x + bulge, y: b.y }, t);
}

export interface LinkWire {
  id: string;
  link: LinkInfo;
  from: Point;
  to: Point;
  d: string;
  /** Where the label chip sits (t = 0.5 of the curve). */
  mid: Point;
  offset: number;
}

/** One wire per link whose two sessions are both on the canvas. */
export function linkWires(layout: CanvasLayout, links: readonly LinkInfo[]): LinkWire[] {
  const out: LinkWire[] = [];
  for (const link of links) {
    const ends = linkEnds(layout, link);
    if (!ends) continue;
    const offset = linkOffset(link, links);
    const t = chipT(offset);
    const c = ends.side ? sideCurve(ends.from, ends.to, offset < 0 ? LINK_OFFSET + 18 : 0, t) : linkCurve(ends.from, ends.to, offset, t);
    out.push({ id: link.id, link, from: ends.from, to: ends.to, d: c.d, mid: c.mid, offset });
  }
  return out;
}

// ---- chip ----

export type LinkTone = 'ok' | 'limit' | 'bad' | 'paused';

export interface LinkChip {
  text: string;
  tone: LinkTone;
  /** Tooltip / aria text. */
  title: string;
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function linkChip(link: LinkInfo): LinkChip {
  const count = `${link.forwards}/${link.maxForwards}`;
  const err = serverText(link);
  if (link.paused) return { text: `⏸ ${count}`, tone: 'paused', title: t('canvas.link.pausedTitle', { count }) };
  switch (link.state) {
    case 'limit':
      return { text: t('canvas.link.limitText', { max: link.maxForwards }), tone: 'limit', title: t('canvas.link.limitTitle', { max: link.maxForwards }) };
    case 'rate':
      return { text: `⚠ ${trunc(err || t('canvas.link.rateFallback'), ERR_CHARS)}`, tone: 'bad', title: err || t('canvas.link.rateTitle') };
    case 'error':
      return { text: `⚠ ${trunc(err || t('canvas.link.errorFallback'), ERR_CHARS)}`, tone: 'bad', title: err || t('canvas.link.errorFallback') };
    default:
      return { text: `↻ ${count}`, tone: 'ok', title: t('canvas.link.okTitle', { count }) };
  }
}

export interface LinkActions {
  /** Pause when running, resume when paused. */
  pauseLabel: string;
  pausedNext: boolean;
  /** "ไปต่อ" (link_resume) is offered only when the link stopped by itself. */
  canContinue: boolean;
}

export function linkActions(link: LinkInfo): LinkActions {
  return {
    pauseLabel: link.paused ? t('canvas.link.resume') : t('canvas.link.pause'),
    pausedNext: !link.paused,
    canContinue: link.state !== 'ok',
  };
}

/** Max forwards from a text box: whole number 1..50, else null. */
export function parseMaxForwards(raw: string | number): number | null {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < MAX_FORWARDS_MIN || n > MAX_FORWARDS_MAX) return null;
  return n;
}

// ---- flow animation ----

/**
 * Compares the last forward time of each link with the previous pass. Returns the links whose `lastForwardAt`
 * changed to a newer time (they get the flow animation) and the map to remember. A link seen for the first
 * time is only recorded: opening the page does not replay old forwards.
 */
export function detectForwards(
  prev: Readonly<Record<string, number | null>> | null,
  links: readonly Pick<LinkInfo, 'id' | 'lastForwardAt'>[],
): { fired: string[]; next: Record<string, number | null> } {
  const next: Record<string, number | null> = {};
  const fired: string[] = [];
  for (const l of links) {
    next[l.id] = l.lastForwardAt;
    if (!prev || !(l.id in prev)) continue;
    const before = prev[l.id];
    if (l.lastForwardAt !== null && (before === null || l.lastForwardAt > before)) fired.push(l.id);
  }
  return { fired, next };
}
