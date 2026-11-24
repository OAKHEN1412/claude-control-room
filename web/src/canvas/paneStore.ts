// Pane nodes of UI v2: work panes that live on the canvas in world coordinates (pan and zoom with it).
// Pure state operations (no React) plus persistence under cr-layout-v2b, migrated from cr-layout-v2.
import { loadLayout2, type StoredLayout2 } from '../layoutV2';
import { allBoxes, type Box, type CanvasLayout, type Point } from './canvasLayout';
import { COMPACT_ZOOM } from './lod';
import type { View } from './viewport';

/** What a pane shows: a whole session, or one subagent of it. */
export interface PaneSource {
  sessionId: string;
  agentId: string | null;
}

export interface PaneNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order; the highest z is the most recently focused pane. */
  z: number;
  source: PaneSource | null;
  /** Migrated pane that has not been given a session yet (it takes a running one when the list arrives). */
  auto?: boolean;
  /** Migrated pane that has no canvas position yet (placed right of the graph once the layout is known). */
  unplaced?: boolean;
}

export const PANES_KEY = 'cr-layout-v2b';
export const PANE_W = 520;
export const PANE_H = 420;
export const PANE_MIN_W = 320;
export const PANE_MIN_H = 220;
export const PANE_MAX_W = 1800;
export const PANE_MAX_H = 1600;
export const PANE_GAP = 56;
export { COMPACT_ZOOM };
/** Extra screen px around the viewport in which a pane still renders its log. */
export const CULL_MARGIN = 160;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export const isCompactZoom = (k: number): boolean => k < COMPACT_ZOOM;
export const paneBox = (p: PaneNode): Box => ({ x: p.x, y: p.y, w: p.w, h: p.h });

// ---- operations (all pure; an unchanged result returns the same array) ----

export function nextPaneId(panes: readonly PaneNode[]): string {
  let max = 0;
  for (const p of panes) {
    const m = /^p(\d+)$/.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `p${max + 1}`;
}

const topZ = (panes: readonly PaneNode[]): number => panes.reduce((a, p) => Math.max(a, p.z), 0);

export interface NewPane {
  x: number;
  y: number;
  w?: number;
  h?: number;
  source?: PaneSource | null;
}

export function addPane(panes: readonly PaneNode[], init: NewPane): { panes: PaneNode[]; id: string } {
  const id = nextPaneId(panes);
  const pane: PaneNode = {
    id,
    x: init.x,
    y: init.y,
    w: clamp(init.w ?? PANE_W, PANE_MIN_W, PANE_MAX_W),
    h: clamp(init.h ?? PANE_H, PANE_MIN_H, PANE_MAX_H),
    z: topZ(panes) + 1,
    source: init.source ?? null,
  };
  return { panes: [...panes, pane], id };
}

export const removePane = (panes: readonly PaneNode[], id: string): PaneNode[] => panes.filter((p) => p.id !== id);

function update(panes: PaneNode[], id: string, fn: (p: PaneNode) => PaneNode): PaneNode[] {
  let changed = false;
  const out = panes.map((p) => {
    if (p.id !== id) return p;
    const n = fn(p);
    if (n !== p) changed = true;
    return n;
  });
  return changed ? out : panes;
}

export function movePane(panes: PaneNode[], id: string, x: number, y: number): PaneNode[] {
  return update(panes, id, (p) => (p.x === x && p.y === y && !p.unplaced ? p : { ...p, x, y, unplaced: undefined }));
}

export function resizePane(panes: PaneNode[], id: string, w: number, h: number): PaneNode[] {
  const nw = clamp(w, PANE_MIN_W, PANE_MAX_W);
  const nh = clamp(h, PANE_MIN_H, PANE_MAX_H);
  return update(panes, id, (p) => (p.w === nw && p.h === nh ? p : { ...p, w: nw, h: nh }));
}

/** A pane has at most one input: connecting replaces whatever was there. */
export function connectPane(panes: PaneNode[], id: string, source: PaneSource): PaneNode[] {
  return update(panes, id, (p) => {
    const same = p.source?.sessionId === source.sessionId && p.source.agentId === source.agentId;
    return same && !p.auto ? p : { ...p, source: { sessionId: source.sessionId, agentId: source.agentId }, auto: undefined };
  });
}

export function disconnectPane(panes: PaneNode[], id: string): PaneNode[] {
  return update(panes, id, (p) => (p.source === null && !p.auto ? p : { ...p, source: null, auto: undefined }));
}

/** Keeps the session, drops the subagent. */
export function clearAgent(panes: PaneNode[], id: string): PaneNode[] {
  return update(panes, id, (p) => (p.source && p.source.agentId !== null ? { ...p, source: { sessionId: p.source.sessionId, agentId: null } } : p));
}

export function focusPane(panes: PaneNode[], id: string): PaneNode[] {
  const top = topZ(panes);
  return update(panes, id, (p) => (p.z === top && panes.filter((q) => q.z === top).length === 1 ? p : { ...p, z: top + 1 }));
}

/** The most recently focused pane (highest z), or null. */
export function topPane(panes: readonly PaneNode[]): PaneNode | null {
  let best: PaneNode | null = null;
  for (const p of panes) if (!best || p.z >= best.z) best = p;
  return best;
}

/** Panes that show exactly this block (session when agentId is null, otherwise that subagent). */
export function panesShowing(panes: readonly PaneNode[], sessionId: string, agentId: string | null): PaneNode[] {
  return panes.filter((p) => p.source && p.source.sessionId === sessionId && p.source.agentId === agentId);
}

/** Connections to sessions that no longer exist are cut; the pane stays. Same array when nothing changed. */
export function prunePanes(panes: PaneNode[], live: ReadonlySet<string>): PaneNode[] {
  let changed = false;
  const out = panes.map((p) => {
    if (p.source && !live.has(p.source.sessionId)) {
      changed = true;
      return { ...p, source: null };
    }
    return p;
  });
  return changed ? out : panes;
}

// ---- placement ----

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inflate = (b: Box, g: number): Box => ({ x: b.x - g, y: b.y - g, w: b.w + 2 * g, h: b.h + 2 * g });

/**
 * The first spot at or below `start` where a w x h pane keeps `gap` clear of every obstacle.
 * Falls back to the right of everything, so it always returns.
 */
export function findFreeSpot(size: { w: number; h: number }, start: Point, obstacles: readonly Box[], gap = PANE_GAP / 2): Point {
  const step = 48;
  for (let i = 0; i < 80; i++) {
    const at = { x: start.x, y: start.y + i * step };
    const box = inflate({ x: at.x, y: at.y, w: size.w, h: size.h }, gap);
    if (!obstacles.some((o) => overlaps(box, o))) return at;
  }
  const right = obstacles.reduce((a, o) => Math.max(a, o.x + o.w), start.x);
  return { x: right + PANE_GAP, y: start.y };
}

/** Where a pane fed by `sessionId` goes: right of that session's block (card + round nodes), top aligned. */
export function startNextTo(layout: CanvasLayout, sessionId: string): Point | null {
  const s = layout.sessions.find((x) => x.sessionId === sessionId);
  if (!s) return null;
  let right = s.card.x + s.card.w;
  for (const b of s.subs) right = Math.max(right, b.box.x + b.box.w);
  return { x: right + PANE_GAP, y: s.card.y };
}

/** Obstacles for placement: everything on the graph plus the existing panes. */
export function placementObstacles(layout: CanvasLayout, panes: readonly PaneNode[]): Box[] {
  return [...allBoxes(layout), ...panes.filter((p) => !p.unplaced).map(paneBox)];
}

/** Gives migrated panes (no position yet) a spot right of the graph, one under the other. */
export function placeUnplaced(panes: PaneNode[], layout: CanvasLayout): PaneNode[] {
  if (!panes.some((p) => p.unplaced)) return panes;
  const graph = allBoxes(layout);
  const right = graph.reduce((a, b) => Math.max(a, b.x + b.w), 0);
  let cur = panes;
  for (const p of panes) {
    if (!p.unplaced) continue;
    const spot = findFreeSpot(p, { x: right + PANE_GAP, y: layout.bounds.y }, placementObstacles(layout, cur));
    cur = movePane(cur, p.id, spot.x, spot.y);
  }
  return cur;
}

// ---- auto connection of migrated panes ----

const ACTIVE = new Set(['running', 'waiting']);

/**
 * Migrated panes (flag `auto`) take a running/waiting session each, not used by another pane.
 * Once a session list exists the flag is cleared either way, so a later disconnect stays disconnected.
 */
export function autoConnect(panes: PaneNode[], sessions: ReadonlyArray<{ sessionId: string; status: string }>): PaneNode[] {
  if (sessions.length === 0 || !panes.some((p) => p.auto)) return panes;
  const used = new Set(panes.filter((p) => p.source && !p.auto).map((p) => p.source!.sessionId));
  const free = sessions.filter((s) => ACTIVE.has(s.status) && !used.has(s.sessionId)).map((s) => s.sessionId);
  return panes.map((p) => {
    if (!p.auto) return p;
    const sid = free.shift();
    return { ...p, source: sid ? { sessionId: sid, agentId: null } : p.source, auto: undefined };
  });
}

// ---- viewport culling ----

/** True when the pane is on screen (with a margin), so its log needs to render. */
export function paneVisible(p: Box, view: View, size: { w: number; h: number }, margin = CULL_MARGIN): boolean {
  const x1 = p.x * view.k + view.x;
  const y1 = p.y * view.k + view.y;
  const x2 = x1 + p.w * view.k;
  const y2 = y1 + p.h * view.k;
  return x2 >= -margin && y2 >= -margin && x1 <= size.w + margin && y1 <= size.h + margin;
}

/** One line for the compact view: the latest thought, else the newest timeline text. */
export function lastLine(s: { thought: string; timeline: ReadonlyArray<{ text: string }> }): string {
  const t = s.thought.trim();
  if (t) return t;
  for (let i = s.timeline.length - 1; i >= 0; i--) {
    const line = s.timeline[i].text.split('\n')[0].trim();
    if (line) return line;
  }
  return '';
}

// ---- persistence ----

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function validPane(raw: unknown): PaneNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (!finite(o.x) || !finite(o.y) || !finite(o.w) || !finite(o.h)) return null;
  let source: PaneSource | null = null;
  const s = o.source as Record<string, unknown> | null | undefined;
  if (s && typeof s === 'object' && typeof s.sessionId === 'string' && s.sessionId) {
    source = { sessionId: s.sessionId, agentId: typeof s.agentId === 'string' && s.agentId ? s.agentId : null };
  }
  const pane: PaneNode = {
    id: o.id,
    x: o.x,
    y: o.y,
    w: clamp(o.w, PANE_MIN_W, PANE_MAX_W),
    h: clamp(o.h, PANE_MIN_H, PANE_MAX_H),
    z: finite(o.z) ? o.z : 0,
    source,
  };
  if (o.auto === true) pane.auto = true;
  if (o.unplaced === true) pane.unplaced = true;
  return pane;
}

/** pane1 / pane2 of the old floating layout become two panes right of the graph, connected on first data. */
export function migrateFromV2(v2: Pick<StoredLayout2, 'hidden'>): PaneNode[] {
  const out: PaneNode[] = [];
  (['pane1', 'pane2'] as const).forEach((id, i) => {
    if (v2.hidden[id]) return;
    out.push({ id: `p${out.length + 1}`, x: 0, y: i * (PANE_H + PANE_GAP), w: PANE_W, h: PANE_H, z: out.length + 1, source: null, auto: true, unplaced: true });
  });
  return out;
}

/** Saved pane nodes. No v2b entry yet: migrate from the v2 layout. Never throws. */
export function loadPanes(storage: StorageLike | null = defaultStorage()): PaneNode[] {
  try {
    const raw = storage?.getItem(PANES_KEY);
    if (raw == null) return migrateFromV2(loadLayout2(storage));
    const parsed: unknown = JSON.parse(raw);
    const list = parsed && typeof parsed === 'object' ? (parsed as { panes?: unknown }).panes : null;
    if (!Array.isArray(list)) return migrateFromV2(loadLayout2(storage));
    const seen = new Set<string>();
    const out: PaneNode[] = [];
    for (const item of list) {
      const p = validPane(item);
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function savePanes(panes: readonly PaneNode[], storage: StorageLike | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(PANES_KEY, JSON.stringify({ v: 2, panes }));
    return true;
  } catch {
    return false;
  }
}
