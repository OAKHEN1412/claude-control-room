// Remote machine nodes on the canvas: a column under the local machine node, their SSH attachments, and the
// four-way routing of a dropped wire (pane / session / machine / empty canvas). Pure.
import type { MachineAttachment, MachineInfo } from '../protocolNext';
import { bezier } from './linkWires';
import type { Box, CanvasLayout, Point, StoredPositions } from './canvasLayout';
import { hitPane } from './paneWires';
import type { PaneNode, PaneSource } from './paneStore';

export const RM_W = 200;
export const RM_H = 92;
export const RM_GAP = 30;
/** Space between the local machine node and the first remote one. */
export const RM_TOP_GAP = 24;

export const machineKey = (id: string): string => `mc:${id}`;
export const isMachineKey = (key: string): boolean => key.startsWith('mc:');

export interface MachinePlace {
  id: string;
  box: Box;
}

/** Automatic spot of every machine (a column under the local machine node), overridden by stored positions. */
export function layoutMachines(machines: readonly Pick<MachineInfo, 'id'>[], local: Box, stored: StoredPositions = {}): MachinePlace[] {
  return machines.map((m, i) => {
    const p = stored[machineKey(m.id)];
    const x = p ? p.x : local.x + (local.w - RM_W) / 2;
    const y = p ? p.y : local.y + local.h + RM_TOP_GAP + i * (RM_H + RM_GAP);
    return { id: m.id, box: { x, y, w: RM_W, h: RM_H } };
  });
}

/** Drops stored positions of machines that no longer exist. Same object when nothing changed. */
export function pruneMachinePositions(pos: StoredPositions, ids: ReadonlySet<string>): StoredPositions {
  let changed = false;
  const out: StoredPositions = {};
  for (const [k, v] of Object.entries(pos)) {
    if (isMachineKey(k) && !ids.has(k.slice(3))) changed = true;
    else out[k] = v;
  }
  return changed ? out : pos;
}

// ---- attachments ----

export interface AttachWire {
  key: string;
  sessionId: string;
  machineId: string;
  from: Point;
  to: Point;
  d: string;
  mid: Point;
}

/** Dotted wire from a session's output port round to the right edge of the machine node. */
export function attachWires(layout: CanvasLayout, places: readonly MachinePlace[], attachments: readonly MachineAttachment[]): AttachWire[] {
  const out: AttachWire[] = [];
  for (const at of attachments) {
    const s = layout.sessions.find((x) => x.sessionId === at.sessionId);
    const m = places.find((x) => x.id === at.machineId);
    if (!s || !m) continue;
    const from = { x: s.card.x + s.card.w, y: s.card.y + s.card.h / 2 };
    const to = { x: m.box.x + m.box.w, y: m.box.y + m.box.h / 2 };
    const dx = Math.max(70, Math.abs(from.x - to.x) * 0.25);
    const c = bezier(from, to, { x: from.x + dx, y: from.y }, { x: to.x + dx, y: to.y });
    out.push({ key: `${at.sessionId}>${at.machineId}`, sessionId: at.sessionId, machineId: at.machineId, from, to, d: c.d, mid: c.mid });
  }
  return out;
}

// ---- wire drop routing ----

export interface DropCtx {
  panes: readonly PaneNode[];
  /** Session cards on the canvas. */
  cards: ReadonlyArray<{ sessionId: string; card: Box }>;
  machines: readonly MachinePlace[];
}

export type DropRoute =
  | { kind: 'pane'; id: string }
  | { kind: 'link'; toSessionId: string }
  | { kind: 'attach'; machineId: string }
  | { kind: 'empty'; at: Point }
  | { kind: 'none' };

const inBox = (b: Box, p: Point, pad: number): boolean => p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;

/** The session card under a world point (the input port just outside its left edge counts). */
export function hitCard(cards: DropCtx['cards'], p: Point, portPad = 16): string | null {
  for (const c of cards) if (inBox(c.card, p, 0) || (p.x >= c.card.x - portPad && p.x < c.card.x && p.y >= c.card.y && p.y <= c.card.y + c.card.h)) return c.sessionId;
  return null;
}

export function hitMachine(places: readonly MachinePlace[], p: Point): string | null {
  for (const m of places) if (inBox(m.box, p, 0)) return m.id;
  return null;
}

/**
 * What a wire dropped at `world` does. Four targets, topmost first: a pane node (show the block there), another
 * session (relay link), a remote machine (SSH attach), empty canvas (new pane). Only a whole session can be linked or
 * attached: a wire from a subagent circle, or one dropped on its own session, does nothing there.
 * `overOtherNode` = the pointer is over some node this function does not know (round node, local machine, toolbar).
 */
export function routeDrop(ctx: DropCtx, src: PaneSource, world: Point, overOtherNode: boolean): DropRoute {
  const pane = hitPane(ctx.panes, world);
  if (pane) return { kind: 'pane', id: pane };
  const card = hitCard(ctx.cards, world);
  if (card) return src.agentId === null && card !== src.sessionId ? { kind: 'link', toSessionId: card } : { kind: 'none' };
  const mc = hitMachine(ctx.machines, world);
  if (mc) return src.agentId === null ? { kind: 'attach', machineId: mc } : { kind: 'none' };
  return overOtherNode ? { kind: 'none' } : { kind: 'empty', at: world };
}
