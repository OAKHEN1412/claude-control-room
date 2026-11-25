import type { Status } from '../../../shared/protocol';
import { t, type TKey } from '../i18n';

// Pure layout + label helpers for the network graph. No React here.
// Layout is in real pixels: node height is fixed (never divided by the row count), the stage grows
// taller than the widget when there are many rows, and the widget scrolls inside itself.

export const NODE_H = 44;
export const ROW_H = 52;
export const PAD_Y = 16;
export const MIN_WIDTH = 360;
/** Narrowest subagent node: ~16 Thai characters plus the model badge. */
export const MIN_SUB_W = 230;
/** A subagent stays visible this long after its last activity; older ones are collapsed. */
export const RECENT_MS = 10 * 60 * 1000;

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

export interface LayoutAgent {
  id: string;
  status?: Status;
  finished?: boolean;
  lastActivity?: number;
}

export interface LayoutSession {
  sessionId: string;
  subagents: ReadonlyArray<LayoutAgent>;
}

export interface LayoutOptions {
  width: number; // stage width in px
  minHeight?: number; // stage is at least this tall (the widget height) so the graph is centred
  now?: number; // epoch ms, for the 10-minute rule
  expanded?: ReadonlySet<string>; // session ids whose finished subagents are shown
}

export interface LayoutNode {
  kind: 'session' | 'subagent' | 'collapsed';
  key: string;
  sessionId: string;
  agentId: string | null; // subagent id; null otherwise
  count: number; // for 'collapsed': how many finished subagents are folded; else 0
  expanded: boolean; // for 'collapsed': currently expanded
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutEdge {
  key: string;
  kind: 'session' | 'subagent';
  sessionId: string;
  path: string;
}

export interface GraphLayout {
  width: number;
  height: number;
  machine: Box;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  empty: boolean;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Right-angle connector: horizontal, vertical at the midpoint, horizontal. */
export function elbowPath(from: Point, to: Point): string {
  const mid = r2((from.x + to.x) / 2);
  return `M ${r2(from.x)} ${r2(from.y)} H ${mid} V ${r2(to.y)} H ${r2(to.x)}`;
}

/** Visible = working or waiting, or active within RECENT_MS. */
export function isRecentAgent(a: LayoutAgent, now: number): boolean {
  if (a.status === 'running' || a.status === 'waiting') return true;
  if (a.lastActivity === undefined) return true;
  return now - a.lastActivity <= RECENT_MS;
}

export function layoutGraph(sessions: ReadonlyArray<LayoutSession>, opts: LayoutOptions): GraphLayout {
  const avail = Math.max(MIN_WIDTH, opts.width);
  const now = opts.now ?? Date.now();
  const expanded = opts.expanded ?? new Set<string>();

  const machineW = Math.max(90, Math.round(avail * 0.13));
  const sessionX = Math.round(avail * 0.18);
  const sessionW = Math.round(avail * 0.31);
  const subX = Math.round(avail * 0.56);
  // Subagent width follows the space that is left; never below MIN_SUB_W. When that does not fit,
  // the stage becomes wider than the widget and the widget scrolls horizontally.
  const subW = Math.max(MIN_SUB_W, avail - subX);
  const W = Math.max(avail, subX + subW);

  const blocks = sessions.map((s) => {
    const open = expanded.has(s.sessionId);
    const shown = s.subagents.filter((a) => open || isRecentAgent(a, now)).map((a) => a.id);
    const hidden = s.subagents.length - s.subagents.filter((a) => isRecentAgent(a, now)).length;
    const slots = Math.max(1, shown.length + (hidden > 0 ? 1 : 0));
    return { sid: s.sessionId, shown, hidden, open, slots };
  });

  const rows = blocks.reduce((n, b) => n + b.slots, 0);
  const height = Math.max(opts.minHeight ?? 0, rows * ROW_H + 2 * PAD_Y);
  const machine: Box = { x: 0, y: r2(height / 2 - 100), w: machineW, h: 200 };
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];

  if (rows === 0) return { width: W, height, machine, nodes, edges, empty: true };

  const machineRight: Point = { x: machineW, y: height / 2 };
  const top = (height - rows * ROW_H) / 2;

  const add = (n: Omit<LayoutNode, 'h'>) => {
    nodes.push({ ...n, x: r2(n.x), y: r2(n.y), w: r2(n.w), h: NODE_H });
  };

  let row = 0;
  for (const b of blocks) {
    const cy = top + (row + b.slots / 2) * ROW_H;
    add({ kind: 'session', key: `s:${b.sid}`, sessionId: b.sid, agentId: null, count: 0, expanded: false,
      x: sessionX, y: cy - NODE_H / 2, w: sessionW });
    edges.push({ key: `m:${b.sid}`, kind: 'session', sessionId: b.sid,
      path: elbowPath(machineRight, { x: sessionX, y: cy }) });

    const sessionRight: Point = { x: sessionX + sessionW, y: cy };
    b.shown.forEach((aid, i) => {
      const ay = top + (row + i + 0.5) * ROW_H;
      add({ kind: 'subagent', key: `a:${b.sid}:${aid}`, sessionId: b.sid, agentId: aid, count: 0, expanded: false,
        x: subX, y: ay - NODE_H / 2, w: subW });
      edges.push({ key: `e:${b.sid}:${aid}`, kind: 'subagent', sessionId: b.sid,
        path: elbowPath(sessionRight, { x: subX, y: ay }) });
    });

    if (b.hidden > 0) {
      const my = top + (row + b.shown.length + 0.5) * ROW_H;
      add({ kind: 'collapsed', key: `more:${b.sid}`, sessionId: b.sid, agentId: null, count: b.hidden, expanded: b.open,
        x: subX, y: my - NODE_H / 2, w: subW });
      edges.push({ key: `e:${b.sid}:more`, kind: 'subagent', sessionId: b.sid,
        path: elbowPath(sessionRight, { x: subX, y: my }) });
    }
    row += b.slots;
  }

  return { width: W, height, machine, nodes, edges, empty: false };
}

// ---- labels and status helpers -------------------------------------------

const STATUS_KEY: Record<Status, TKey> = {
  running: 'panels.status.running',
  waiting: 'panels.status.waiting',
  idle: 'panels.status.idle',
  done: 'panels.status.done',
  unreadable: 'panels.status.unreadable',
};

/** Status word in the current language. Each read translates at access time, so a language switch shows at once. */
export const STATUS_WORD = {} as Record<Status, string>;
for (const s of Object.keys(STATUS_KEY) as Status[]) {
  Object.defineProperty(STATUS_WORD, s, { get: () => t(STATUS_KEY[s]), enumerable: true });
}

export const STATUS_VAR: Record<Status, string> = {
  running: 'var(--running)',
  waiting: 'var(--waiting)',
  idle: 'var(--idle)',
  done: 'var(--done)',
  unreadable: 'var(--error)',
};

/** claude-opus-5-5 -> "opus 5.5"; unknown ids are returned unchanged. */
export function shortModel(model: string | null): string | null {
  if (!model) return null;
  const m = /^claude-([a-z]+)(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/i.exec(model.trim());
  if (!m) return model;
  const name = m[1].toLowerCase();
  if (!m[2]) return name;
  return m[3] !== undefined ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

/** "model · effort" badge; '—' stands for an unknown part, both unknown gives '—'. */
export function badgeText(model: string | null, effort: string | null): string {
  const m = shortModel(model);
  if (!m && !effort) return '—';
  return `${m ?? '—'} · ${effort ?? '—'}`;
}

/** Character state for the machine node: working beats asking beats idle. */
export function machineState(
  sessions: ReadonlyArray<{ status: Status }>,
): 'working' | 'asking' | 'idle' {
  if (sessions.some((s) => s.status === 'running')) return 'working';
  if (sessions.some((s) => s.status === 'waiting')) return 'asking';
  return 'idle';
}
