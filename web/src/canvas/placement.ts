// Collision-aware placement for every node kind of the canvas (session blocks, remote machines, pane nodes). Pure.
//
// A session "block" is the card, its caption and all its round nodes taken together (one bounding box). New or
// unplaced nodes go to the first free slot that keeps PLACE_MARGIN clear of every other node. A node the user
// dragged (stored position) is never moved, except that two stored session blocks that overlap heavily are pulled
// apart (the later one is nudged down).
import {
  CARD_H,
  COL_GAP,
  MACHINE_KEY,
  MACHINE_W,
  MAX_PER_COL,
  SESSION_COL_W,
  SHAPE,
  allBoxes,
  applyPositions,
  keySession,
  unionBox,
  type Box,
  type CanvasLayout,
  type Point,
  type SessionPlace,
  type StoredPositions,
} from './canvasLayout';
import { RM_GAP, RM_H, RM_TOP_GAP, RM_W, layoutMachines, machineKey, type MachinePlace } from './machineLayout';
import { findFreeSpotAvoiding } from './seams';
import { findFreeSpot, movePane, paneBox, startNextTo, type PaneNode } from './paneStore';

/** Free space kept between two nodes (world px). */
export const PLACE_MARGIN = 24;

const hit = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inflate = (b: Box, g: number): Box => ({ x: b.x - g, y: b.y - g, w: b.w + 2 * g, h: b.h + 2 * g });
const area = (b: Box): number => Math.max(0, b.w) * Math.max(0, b.h);

/** Intersection area as a share of the smaller box (0 when apart, 1 when one lies inside the other). */
export function overlapRatio(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const m = Math.min(area(a), area(b));
  return m <= 0 ? 0 : (w * h) / m;
}

/** Card + caption + every round node of a session as one box. */
export function sessionBlock(s: SessionPlace): Box {
  return unionBox([s.card, s.caption, ...s.subs.map((b) => b.box)]);
}

function shiftSession(s: SessionPlace, dx: number, dy: number): SessionPlace {
  if (dx === 0 && dy === 0) return s;
  const sb = (b: Box): Box => ({ ...b, x: b.x + dx, y: b.y + dy });
  const sp = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  return { ...s, card: sb(s.card), caption: sb(s.caption), modelPort: sp(s.modelPort), agentsPort: sp(s.agentsPort), subs: s.subs.map((b) => ({ ...b, box: sb(b.box) })) };
}

/** The session at its automatic slot with the stored round-node offsets applied (its own position is ignored). */
function withOffsets(s: SessionPlace, stored: StoredPositions, auto: CanvasLayout): SessionPlace {
  const sub: StoredPositions = {};
  for (const b of s.subs) if (stored[b.key]) sub[b.key] = stored[b.key];
  return applyPositions({ ...auto, sessions: [s] }, sub).sessions[0];
}

export interface PlaceOptions {
  perCol?: number;
  /** Fixed boxes the sessions must keep clear of. */
  obstacles?: readonly Box[];
  /**
   * Pull two heavily overlapping stored session blocks apart (default true). The canvas passes false: every
   * placed node is stored, so a block that grows (more subagent rows) must never push another one away.
   */
  separateStored?: boolean;
}

/**
 * Final positions of the local machine node and every session block.
 * `auto` is layoutCanvas' automatic layout; `stored` the user's dragged positions.
 */
export function resolvePlacement(auto: CanvasLayout, stored: StoredPositions, opts: PlaceOptions = {}): CanvasLayout {
  const perCol = Math.max(1, Math.floor(opts.perCol ?? MAX_PER_COL));
  const fixedObstacles = opts.obstacles ?? [];
  const slots = auto.sessions.map((s) => withOffsets(s, stored, auto));
  const result = new Map<string, SessionPlace>();
  const placed: SessionPlace[] = [];

  // 1. dragged sessions stay where the user left them; only heavy overlaps with an earlier dragged one are fixed.
  const heavy = (p: SessionPlace, q: SessionPlace): boolean => overlapRatio(p.card, q.card) > 0.5 || overlapRatio(sessionBlock(p), sessionBlock(q)) > 0.5;
  slots.forEach((s) => {
    const at = stored[s.sessionId];
    if (!at) return;
    let p = shiftSession(s, at.x - s.card.x, at.y - s.card.y);
    for (let guard = 0; guard < 200 && opts.separateStored !== false; guard++) {
      const other = placed.find((q) => heavy(p, q));
      if (!other) break;
      const b = sessionBlock(other);
      p = shiftSession(p, 0, b.y + b.h + PLACE_MARGIN - sessionBlock(p).y);
    }
    placed.push(p);
    result.set(s.sessionId, p);
  });

  // 2. the others keep their automatic slot when it is free, else take the first free one.
  const isFree = (blk: Box): boolean => {
    const g = inflate(blk, PLACE_MARGIN);
    return !placed.some((q) => hit(g, sessionBlock(q))) && !fixedObstacles.some((o) => hit(g, o));
  };
  const inColumn = (x: number): number => placed.filter((q) => Math.abs(q.card.x - x) < SESSION_COL_W / 2).length;
  slots.forEach((s) => {
    if (stored[s.sessionId]) return;
    let p = s;
    if (!isFree(sessionBlock(p))) {
      const blk = sessionBlock(s);
      const bx = blk.x - s.card.x;
      const by = blk.y - s.card.y;
      const bottoms = [0, ...placed.map((q) => sessionBlock(q).y + sessionBlock(q).h + PLACE_MARGIN), ...fixedObstacles.map((o) => o.y + o.h + PLACE_MARGIN)];
      const ys = [...new Set(bottoms)].sort((a, b) => a - b);
      let found: SessionPlace | null = null;
      for (let col = 0; col < 2000 && !found; col++) {
        const x = MACHINE_W + COL_GAP + col * SESSION_COL_W;
        if (inColumn(x) >= perCol) continue;
        for (const y of ys) {
          if (isFree({ x: x + bx, y: y + by, w: blk.w, h: blk.h })) {
            found = shiftSession(s, x - s.card.x, y - s.card.y);
            break;
          }
        }
      }
      if (found) p = found;
    }
    placed.push(p);
    result.set(s.sessionId, p);
  });

  const sessions = auto.sessions.map((s) => result.get(s.sessionId)!);
  const m = stored[MACHINE_KEY];
  let machine = auto.machine;
  if (m) machine = { ...auto.machine, x: m.x, y: m.y };
  else if (sessions.length > 0) {
    const centre = sessions.reduce((a, p) => a + p.card.y + CARD_H / 2, 0) / sessions.length;
    machine = { ...auto.machine, y: Math.round((centre - (SHAPE.dy + SHAPE.h / 2)) * 100) / 100 };
  }
  const out: CanvasLayout = { machine, sessions, bounds: auto.bounds, empty: auto.empty, extras: auto.extras };
  out.bounds = unionBox(allBoxes(out));
  return out;
}

/**
 * Stored positions that differ from the settled ones, in the form applyPositions expects on top of a layout that
 * already contains the settled positions (a round node's key holds an offset, so it becomes the difference).
 */
export function liveOverride(live: StoredPositions, settled: StoredPositions): StoredPositions {
  const out: StoredPositions = {};
  for (const [k, v] of Object.entries(live)) {
    const s = settled[k];
    if (s && s.x === v.x && s.y === v.y) continue;
    const sid = keySession(k);
    const isOffset = k !== MACHINE_KEY && sid !== null && sid !== k;
    out[k] = isOffset ? { x: v.x - (s?.x ?? 0), y: v.y - (s?.y ?? 0) } : v;
  }
  return out;
}

/** Remote machine nodes: dragged ones stay, the others take the first free spot of the column under the local node. */
export function placeMachines(machines: readonly { id: string }[], local: Box, layout: CanvasLayout, stored: StoredPositions): MachinePlace[] {
  const base = layoutMachines(machines, local, stored);
  const fixed = base.filter((m) => stored[machineKey(m.id)]);
  const taken: Box[] = [local, ...layout.sessions.map(sessionBlock), ...fixed.map((m) => m.box)];
  const x = local.x + (local.w - RM_W) / 2;
  const out = new Map<string, MachinePlace>(fixed.map((m) => [m.id, m]));
  for (const m of base) {
    if (out.has(m.id)) continue;
    let y = local.y + local.h + RM_TOP_GAP;
    let box: Box = { x, y, w: RM_W, h: RM_H };
    for (let i = 0; i < 400 && taken.some((o) => hit(inflate(box, PLACE_MARGIN), o)); i++) {
      y += (RM_H + RM_GAP) / 2;
      box = { x, y, w: RM_W, h: RM_H };
    }
    taken.push(box);
    out.set(m.id, { id: m.id, box });
  }
  return machines.map((m) => out.get(m.id)!);
}

/** Layout with the remote machine boxes added as extras (what fit-to-view and pane placement look at). */
export function withMachines(layout: CanvasLayout, places: readonly MachinePlace[]): CanvasLayout {
  const out: CanvasLayout = { ...layout, extras: places.map((m) => m.box) };
  out.bounds = unionBox(allBoxes(out));
  return out;
}

// ---- panes ----

/** Panes sitting on a graph node (or heavily on an earlier pane) move to the first free spot, right of their session if connected. */
export function resolvePanes(panes: PaneNode[], layout: CanvasLayout): PaneNode[] {
  const graph = allBoxes(layout);
  const kept: Box[] = [];
  let cur = panes;
  for (const p of panes) {
    if (p.unplaced) continue;
    const b = paneBox(p);
    if (graph.some((g) => hit(b, g)) || kept.some((k) => overlapRatio(b, k) > 0.5)) {
      const start = (p.source ? startNextTo(layout, p.source.sessionId) : null) ?? { x: p.x, y: p.y };
      const spot = findFreeSpot(p, start, [...graph, ...kept]);
      cur = movePane(cur, p.id, spot.x, spot.y);
      kept.push({ x: spot.x, y: spot.y, w: p.w, h: p.h });
    } else kept.push(b);
  }
  return cur;
}

/** "Re-arrange": connected panes go next to their session again; the others only leave nodes they sit on. */
export function relayoutPanes(panes: PaneNode[], layout: CanvasLayout, seamed?: { start: Point; bands: readonly Box[] }): PaneNode[] {
  const live = new Set(layout.sessions.map((s) => s.sessionId));
  const wired = (p: PaneNode): boolean => !!p.source && live.has(p.source.sessionId);
  const graph = allBoxes(layout);
  const loose = resolvePanes(
    panes.filter((p) => !wired(p)),
    layout,
  );
  const kept: Box[] = loose.filter((p) => !p.unplaced).map(paneBox);
  const moved = new Map<string, PaneNode>(loose.map((p) => [p.id, p]));
  for (const p of panes) {
    if (!wired(p)) continue;
    // several monitors: connected panes go to the last monitor (wires still link them), not next to their block
    const start = seamed ? seamed.start : (startNextTo(layout, p.source!.sessionId) ?? { x: p.x, y: p.y });
    const spot = seamed ? findFreeSpotAvoiding(p, start, [...graph, ...kept], seamed.bands) : findFreeSpot(p, start, [...graph, ...kept]);
    kept.push({ x: spot.x, y: spot.y, w: p.w, h: p.h });
    moved.set(p.id, { ...p, x: spot.x, y: spot.y, unplaced: undefined });
  }
  return panes.map((p) => moved.get(p.id) ?? p);
}

/** Everything that must be visible after "fit": all node boxes (cards, captions, circles, machines) and placed panes. */
export function fitBoundsOf(layout: CanvasLayout, panes: readonly PaneNode[]): Box {
  return unionBox([...allBoxes(layout), ...panes.filter((p) => !p.unplaced).map(paneBox)]);
}

/**
 * Positions to remember so that no node ever moves again by itself: the automatic spot of every session, the local
 * machine node and every remote machine that has no stored position yet. Returns `stored` itself when nothing is new.
 */
export function persistAutoPlacement(stored: StoredPositions, layout: CanvasLayout, machines: readonly MachinePlace[]): StoredPositions {
  let out = stored;
  const put = (key: string, at: Point): void => {
    if (out === stored) out = { ...stored };
    out[key] = { x: at.x, y: at.y };
  };
  for (const s of layout.sessions) if (!stored[s.sessionId]) put(s.sessionId, { x: s.card.x, y: s.card.y });
  if (layout.sessions.length > 0 && !stored[MACHINE_KEY]) put(MACHINE_KEY, { x: layout.machine.x, y: layout.machine.y });
  for (const m of machines) if (!stored[machineKey(m.id)]) put(machineKey(m.id), { x: m.box.x, y: m.box.y });
  return out;
}
