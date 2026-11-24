// Pure layout for the n8n-style work canvas. No React. World coordinates in px.
//
//   machine ──► [ session card ]            session = wide card, input port left, output port right
//                  ◆ Model    ◆ Subagents   diamond ports on the bottom edge
//                  ┆          ┆ ┆ ┆         dashed lines down to round nodes
//                 (opus)   (agent)(agent)…(+N)
//
// Sessions are stacked top to bottom in columns of at most MAX_PER_COL; a session's round nodes sit in a grid under its card.
// Stored node positions (see canvasStore.ts) override the automatic positions.

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CARD_W = 264;
export const CARD_H = 84;
/** Thought text under the card, 2 lines. */
export const CAPTION_GAP = 24;
export const CAPTION_H = 36;
export const ITEM_W = 112;
export const ITEM_H = 108;
export const CIRCLE = 56;
export const PER_ROW = 5;
/** At most this many subagent circles; the rest fold into one "+N" circle. */
export const MAX_SUBS = 8;
export const SUBS_TOP = 150;
export const BLOCK_GAP = 36;
export const MACHINE_W = 160;
export const MACHINE_H = 200;
export const COL_GAP = 96;
/** Sessions fill a column top to bottom, then start the next column to its right (keeps fit-to-view readable). */
export const MAX_PER_COL = 5;
/** Width of one session column: the card's round-node grid (model + PER_ROW) plus a gap. */
export const SESSION_COL_W = 8 + (PER_ROW + 1) * ITEM_W + COL_GAP;
/** A subagent stays visible this long after its last activity; older ones are folded. */
export const RECENT_MS = 10 * 60 * 1000;

/** The trigger-shaped machine node inside its footprint (character above, label below). */
export const SHAPE = { dx: 12, dy: 72, w: 128, h: 84 } as const;

export type SubKind = 'model' | 'agent' | 'more';

export interface CanvasAgent {
  id: string;
  status?: string;
  finished?: boolean;
  lastActivity?: number;
}

export interface CanvasSession {
  sessionId: string;
  subagents: ReadonlyArray<CanvasAgent>;
}

export interface LayoutOptions {
  now?: number;
  /** Session ids whose folded subagents are all shown. */
  expanded?: ReadonlySet<string>;
  /** Sessions per column (default MAX_PER_COL). */
  perCol?: number;
}

export interface SubPlace {
  key: string; // stable key, also the key of a stored offset
  kind: SubKind;
  agentId: string | null;
  count: number; // 'more': how many subagents are folded (collapsed) / shown beyond the cap (expanded)
  expanded: boolean; // 'more': currently expanded
  box: Box; // footprint: circle on top, label under it
}

export interface SessionPlace {
  sessionId: string;
  card: Box;
  caption: Box;
  modelPort: Point; // diamond on the card's bottom edge
  agentsPort: Point;
  subs: SubPlace[];
}

export interface CanvasLayout {
  machine: Box;
  sessions: SessionPlace[];
  bounds: Box; // everything, no padding
  empty: boolean;
  /** Other boxes that take room (remote machine nodes); added by the canvas, not by layoutCanvas. */
  extras?: Box[];
}

export const MACHINE_KEY = 'machine';
export const modelKey = (sid: string): string => `${sid}:model`;
export const agentKey = (sid: string, aid: string): string => `${sid}:a:${aid}`;
export const moreKey = (sid: string): string => `${sid}:more`;
/** The session id a stored key belongs to ('machine' belongs to none). */
export function keySession(key: string): string | null {
  if (key === MACHINE_KEY || key.startsWith('mc:')) return null;
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

export function isRecentAgent(a: CanvasAgent, now: number): boolean {
  if (a.status === 'running' || a.status === 'waiting') return true;
  if (a.lastActivity === undefined) return true;
  return now - a.lastActivity <= RECENT_MS;
}

/**
 * Which subagents get a circle. Expanded: all of them. Otherwise only recent ones, at most MAX_SUBS
 * (working/waiting first, then the most recently active); the output keeps the input order.
 * `hidden` is how many are not shown.
 */
export function pickAgents(
  agents: ReadonlyArray<CanvasAgent>,
  now: number,
  expanded: boolean,
): { shown: CanvasAgent[]; hidden: number } {
  if (expanded) return { shown: [...agents], hidden: 0 };
  const recent = agents.filter((a) => isRecentAgent(a, now));
  let keep = recent;
  if (recent.length > MAX_SUBS) {
    const live = (a: CanvasAgent) => (a.status === 'running' || a.status === 'waiting' ? 1 : 0);
    const best = new Set(
      [...recent]
        .sort((a, b) => live(b) - live(a) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
        .slice(0, MAX_SUBS)
        .map((a) => a.id),
    );
    keep = recent.filter((a) => best.has(a.id));
  }
  return { shown: keep, hidden: agents.length - keep.length };
}

export const machineOut = (m: Box): Point => ({ x: m.x + SHAPE.dx + SHAPE.w, y: m.y + SHAPE.dy + SHAPE.h / 2 });
export const cardIn = (c: Box): Point => ({ x: c.x, y: c.y + c.h / 2 });
export const circleTop = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y });

export function unionBox(boxes: Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Every box that takes room on the canvas (machine, cards, captions, round nodes). */
export function allBoxes(l: CanvasLayout): Box[] {
  const out: Box[] = [l.machine, ...(l.extras ?? [])];
  for (const s of l.sessions) {
    out.push(s.card, s.caption);
    for (const b of s.subs) out.push(b.box);
  }
  return out;
}

export function layoutCanvas(sessions: ReadonlyArray<CanvasSession>, opts: LayoutOptions = {}): CanvasLayout {
  const now = opts.now ?? Date.now();
  const expanded = opts.expanded ?? new Set<string>();
  const perCol = Math.max(1, Math.floor(opts.perCol ?? MAX_PER_COL));
  const places: SessionPlace[] = [];

  let y = 0;
  let index = 0;
  for (const s of sessions) {
    const col = Math.floor(index / perCol);
    if (index > 0 && index % perCol === 0) y = 0;
    index++;
    const cardX = MACHINE_W + COL_GAP + col * SESSION_COL_W;
    const open = expanded.has(s.sessionId);
    const { shown, hidden } = pickAgents(s.subagents, now, open);
    // "+N" circle: folded count when collapsed; a "hide" circle when expanded past the cap.
    const foldable = open ? Math.max(0, s.subagents.length - MAX_SUBS) : hidden;
    const items: Array<{ kind: SubKind; agentId: string | null }> = shown.map((a) => ({ kind: 'agent', agentId: a.id }));
    if (foldable > 0) items.push({ kind: 'more', agentId: null });

    const rows = Math.max(1, Math.ceil(items.length / PER_ROW));
    const card: Box = { x: cardX, y, w: CARD_W, h: CARD_H };
    const subsTop = y + SUBS_TOP;
    const left = cardX + 8;

    const subs: SubPlace[] = [
      { key: modelKey(s.sessionId), kind: 'model', agentId: null, count: 0, expanded: false, box: { x: left, y: subsTop, w: ITEM_W, h: ITEM_H } },
    ];
    items.forEach((it, i) => {
      const row = Math.floor(i / PER_ROW);
      const col = 1 + (i % PER_ROW);
      const box: Box = { x: left + col * ITEM_W, y: subsTop + row * ITEM_H, w: ITEM_W, h: ITEM_H };
      if (it.kind === 'agent') {
        subs.push({ key: agentKey(s.sessionId, it.agentId as string), kind: 'agent', agentId: it.agentId, count: 0, expanded: false, box });
      } else {
        subs.push({ key: moreKey(s.sessionId), kind: 'more', agentId: null, count: foldable, expanded: open, box });
      }
    });

    places.push({
      sessionId: s.sessionId,
      card,
      caption: { x: cardX, y: y + CARD_H + CAPTION_GAP, w: CARD_W, h: CAPTION_H },
      modelPort: { x: left + ITEM_W / 2, y: y + CARD_H },
      agentsPort: { x: cardX + CARD_W - 64, y: y + CARD_H },
      subs,
    });
    y = subsTop + rows * ITEM_H + BLOCK_GAP;
  }

  const centre = places.length > 0 ? places.reduce((a, p) => a + p.card.y + CARD_H / 2, 0) / places.length : 0;
  const machine: Box = { x: 0, y: r2(centre - (SHAPE.dy + SHAPE.h / 2)), w: MACHINE_W, h: MACHINE_H };
  const layout: CanvasLayout = { machine, sessions: places, bounds: { x: 0, y: 0, w: 0, h: 0 }, empty: places.length === 0 };
  layout.bounds = unionBox(allBoxes(layout));
  return layout;
}

// ---- stored positions -----------------------------------------------------

/**
 * Stored positions by node key. `machine` and a session id hold the absolute top-left of that node;
 * a round node's key (model / agent / more) holds its offset from its automatic slot, so it keeps
 * following its session.
 */
export type StoredPositions = Record<string, Point>;

const shiftBox = (b: Box, dx: number, dy: number): Box => ({ ...b, x: b.x + dx, y: b.y + dy });
const shiftPoint = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy });

/** Applies stored positions to an automatic layout. Pure; returns a new layout. */
export function applyPositions(layout: CanvasLayout, stored: StoredPositions): CanvasLayout {
  const m = stored[MACHINE_KEY];
  const machine = m ? { ...layout.machine, x: m.x, y: m.y } : layout.machine;
  const sessions = layout.sessions.map((s) => {
    const p = stored[s.sessionId];
    const dx = p ? p.x - s.card.x : 0;
    const dy = p ? p.y - s.card.y : 0;
    return {
      ...s,
      card: shiftBox(s.card, dx, dy),
      caption: shiftBox(s.caption, dx, dy),
      modelPort: shiftPoint(s.modelPort, dx, dy),
      agentsPort: shiftPoint(s.agentsPort, dx, dy),
      subs: s.subs.map((b) => {
        const o = stored[b.key];
        return { ...b, box: shiftBox(b.box, dx + (o?.x ?? 0), dy + (o?.y ?? 0)) };
      }),
    };
  });
  const out: CanvasLayout = { machine, sessions, bounds: layout.bounds, empty: layout.empty, extras: layout.extras };
  out.bounds = unionBox(allBoxes(out));
  return out;
}

// ---- edges ---------------------------------------------------------------

/** Horizontal-tangent bezier (machine -> card). */
export function hCurve(a: Point, b: Point): string {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${r2(a.x)} ${r2(a.y)} C ${r2(a.x + dx)} ${r2(a.y)}, ${r2(b.x - dx)} ${r2(b.y)}, ${r2(b.x)} ${r2(b.y)}`;
}

/** Vertical-tangent bezier (diamond port -> round node). */
export function vCurve(a: Point, b: Point): string {
  const dy = Math.max(30, Math.abs(b.y - a.y) * 0.5);
  return `M ${r2(a.x)} ${r2(a.y)} C ${r2(a.x)} ${r2(a.y + dy)}, ${r2(b.x)} ${r2(b.y - dy)}, ${r2(b.x)} ${r2(b.y)}`;
}

export interface CanvasEdge {
  key: string;
  kind: 'machine' | 'model' | 'agent';
  sessionId: string;
  d: string;
}

/** `origins`: sessions that hang from another point than the local machine node (a remote machine's output). */
export function canvasEdges(layout: CanvasLayout, origins?: ReadonlyMap<string, Point>): CanvasEdge[] {
  const out: CanvasEdge[] = [];
  const local = machineOut(layout.machine);
  for (const s of layout.sessions) {
    const from = origins?.get(s.sessionId) ?? local;
    out.push({ key: `m:${s.sessionId}`, kind: 'machine', sessionId: s.sessionId, d: hCurve(from, cardIn(s.card)) });
    for (const b of s.subs) {
      const port = b.kind === 'model' ? s.modelPort : s.agentsPort;
      out.push({ key: `e:${b.key}`, kind: b.kind === 'model' ? 'model' : 'agent', sessionId: s.sessionId, d: vCurve(port, circleTop(b.box)) });
    }
  }
  return out;
}

// ---- model text ----------------------------------------------------------

/** First word of the model name for the inside of the model circle: "claude-opus-5-5" -> "opus". */
export function modelWord(model: string | null): string {
  if (!model) return '?';
  const m = /^claude-([a-z]+)/i.exec(model.trim());
  const w = (m ? m[1] : model.trim().split(/[\s/:·-]+/)[0]) || '?';
  return w.toLowerCase().slice(0, 7);
}
