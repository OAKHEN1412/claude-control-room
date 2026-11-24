// Wires between AI blocks (session output port / subagent circle) and pane nodes (input port). Pure geometry + rules.
import { CIRCLE, hCurve, type CanvasLayout, type Point } from './canvasLayout';
import { panesShowing, type PaneNode, type PaneSource } from './paneStore';

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Input port of a pane: middle of its left edge. */
export const paneIn = (p: Pick<PaneNode, 'x' | 'y' | 'h'>): Point => ({ x: p.x, y: p.y + p.h / 2 });

/** Where a wire for `src` leaves the graph: a session's output port, or the right side of a subagent circle. */
export function sourcePoint(layout: CanvasLayout, src: PaneSource): Point | null {
  const s = layout.sessions.find((x) => x.sessionId === src.sessionId);
  if (!s) return null;
  if (src.agentId !== null) {
    const b = s.subs.find((x) => x.kind === 'agent' && x.agentId === src.agentId);
    if (b) return { x: b.box.x + b.box.w / 2 + CIRCLE / 2, y: b.box.y + CIRCLE / 2 };
  }
  return { x: s.card.x + s.card.w, y: s.card.y + s.card.h / 2 };
}

export interface PaneWire {
  /** The pane id doubles as the wire id: a pane has at most one input. */
  paneId: string;
  sessionId: string;
  agentId: string | null;
  from: Point;
  to: Point;
  d: string;
}

/** The wire into a pane, or null when it is unconnected or its session is not on the canvas. */
export function paneWire(layout: CanvasLayout, pane: PaneNode): PaneWire | null {
  if (!pane.source || pane.unplaced) return null;
  const from = sourcePoint(layout, pane.source);
  if (!from) return null;
  const to = paneIn(pane);
  return { paneId: pane.id, sessionId: pane.source.sessionId, agentId: pane.source.agentId, from, to, d: hCurve(from, to) };
}

export function paneWires(layout: CanvasLayout, panes: readonly PaneNode[]): PaneWire[] {
  const out: PaneWire[] = [];
  for (const p of panes) {
    const w = paneWire(layout, p);
    if (w) out.push(w);
  }
  return out;
}

/** Point at t = 0.5 of the wire's bezier (where the delete button sits). */
export function wireMid(a: Point, b: Point): Point {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  const c1 = { x: a.x + dx, y: a.y };
  const c2 = { x: b.x - dx, y: b.y };
  return { x: r2((a.x + 3 * c1.x + 3 * c2.x + b.x) / 8), y: r2((a.y + 3 * c1.y + 3 * c2.y + b.y) / 8) };
}

/** The pane under a world point (anywhere on it, or on the input port just outside its left edge). Topmost wins. */
export function hitPane(panes: readonly PaneNode[], p: Point, portPad = 16): string | null {
  let best: PaneNode | null = null;
  for (const q of panes) {
    if (q.unplaced) continue;
    const inside = p.x >= q.x - portPad && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h;
    if (inside && (!best || q.z >= best.z)) best = q;
  }
  return best ? best.id : null;
}

export type DropTarget = { kind: 'pane'; id: string } | { kind: 'empty'; at: Point } | { kind: 'none' };

/**
 * What a dropped wire does. A pane under the pointer takes it; empty canvas makes a new pane there;
 * dropping on another node or on the toolbar does nothing.
 */
export function dropTarget(panes: readonly PaneNode[], world: Point, overOtherNode: boolean): DropTarget {
  const id = hitPane(panes, world);
  if (id) return { kind: 'pane', id };
  return overOtherNode ? { kind: 'none' } : { kind: 'empty', at: world };
}

/** Top-left of a new pane dropped at `at`: its input port lands on the drop point. */
export function paneAtDrop(at: Point, h: number): Point {
  return { x: r2(at.x), y: r2(at.y - h / 2) };
}

/** True when the pointer moved far enough from the port for the gesture to count as a wire drag. */
export const isWireDrag = (dx: number, dy: number, px = 4): boolean => Math.hypot(dx, dy) >= px;

// ---- what a click on an AI block does ----

export type ClickRoute = { kind: 'focus'; paneId: string } | { kind: 'drawer' };

/**
 * A click on a session node or subagent circle. A pane already connected to that block comes to the front
 * (the most recently focused one when several show it); otherwise the block opens in the slide-out drawer.
 */
export function routeClick(panes: readonly PaneNode[], sessionId: string, agentId: string | null): ClickRoute {
  const shown = panesShowing(panes, sessionId, agentId).filter((p) => !p.unplaced);
  if (shown.length === 0) return { kind: 'drawer' };
  let best = shown[0];
  for (const p of shown) if (p.z > best.z) best = p;
  return { kind: 'focus', paneId: best.id };
}
