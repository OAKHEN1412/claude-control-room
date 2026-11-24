import { describe, expect, it } from 'vitest';
import { applyPreset2, setHidden, STORAGE_KEY_V2 } from '../layoutV2';
import { CARD_H, CARD_W, MAX_PER_COL, SESSION_COL_W, allBoxes, layoutCanvas, type Box, type CanvasAgent, type CanvasSession } from './canvasLayout';
import { COMPACT_ZOOM, FULL_ZOOM, MAX_LABEL_SCALE, MIN_LABEL_PX, labelPx, labelScale, lodFor, snapToPixel } from './lod';
import {
  PANES_KEY,
  PANE_H,
  PANE_MAX_W,
  PANE_MIN_W,
  PANE_W,
  addPane,
  autoConnect,
  clearAgent,
  connectPane,
  disconnectPane,
  findFreeSpot,
  focusPane,
  isCompactZoom,
  lastLine,
  loadPanes,
  migrateFromV2,
  movePane,
  nextPaneId,
  paneBox,
  paneVisible,
  panesShowing,
  placeUnplaced,
  placementObstacles,
  prunePanes,
  removePane,
  resizePane,
  savePanes,
  startNextTo,
  topPane,
  type PaneNode,
  type StorageLike,
} from './paneStore';
import { dropTarget, hitPane, isWireDrag, paneAtDrop, paneIn, paneWire, paneWires, routeClick, sourcePoint, wireMid } from './paneWires';
import { tweenView, viewForBox } from './viewport';

const NOW = 1_000_000_000_000;
const agents = (sid: string, n: number): CanvasAgent[] => Array.from({ length: n }, (_, i) => ({ id: `${sid}-a${i}`, status: 'running', finished: false, lastActivity: NOW - i }));
const sess = (id: string, subs: CanvasAgent[] = []): CanvasSession => ({ sessionId: id, subagents: subs });
const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function store(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v) };
}

const base = (): PaneNode[] => [];
const withTwo = () => {
  const a = addPane(base(), { x: 0, y: 0 });
  const b = addPane(a.panes, { x: 700, y: 0, source: { sessionId: 's2', agentId: null } });
  return { panes: b.panes, a: a.id, b: b.id };
};

describe('pane store operations', () => {
  it('adds panes with growing ids and z, and clamps the size', () => {
    const { panes, a, b } = withTwo();
    expect([a, b]).toEqual(['p1', 'p2']);
    expect(panes[1].z).toBeGreaterThan(panes[0].z);
    const big = addPane(panes, { x: 0, y: 0, w: 99999, h: 1 });
    expect(big.panes[2].w).toBe(PANE_MAX_W);
    expect(big.panes[2].h).toBeLessThan(PANE_H);
    expect(nextPaneId(removePane(big.panes, 'p1'))).toBe('p4'); // an id is never reused while a higher one exists
  });

  it('removes, moves and resizes; unchanged input returns the same array', () => {
    const { panes } = withTwo();
    expect(removePane(panes, 'p1').map((p) => p.id)).toEqual(['p2']);
    const moved = movePane(panes, 'p1', 50, 60);
    expect(moved.find((p) => p.id === 'p1')).toMatchObject({ x: 50, y: 60 });
    expect(movePane(moved, 'p1', 50, 60)).toBe(moved);
    const sized = resizePane(panes, 'p2', 10, 10);
    expect(sized.find((p) => p.id === 'p2')).toMatchObject({ w: PANE_MIN_W });
    expect(resizePane(sized, 'p2', 10, 10)).toBe(sized);
  });

  it('connects, replaces the single input, and disconnects', () => {
    const { panes } = withTwo();
    const c1 = connectPane(panes, 'p1', { sessionId: 's1', agentId: null });
    expect(c1[0].source).toEqual({ sessionId: 's1', agentId: null });
    const c2 = connectPane(c1, 'p1', { sessionId: 's3', agentId: 'a9' });
    expect(c2[0].source).toEqual({ sessionId: 's3', agentId: 'a9' });
    expect(connectPane(c2, 'p1', { sessionId: 's3', agentId: 'a9' })).toBe(c2);
    expect(clearAgent(c2, 'p1')[0].source).toEqual({ sessionId: 's3', agentId: null });
    expect(disconnectPane(c2, 'p1')[0].source).toBeNull();
    expect(disconnectPane(disconnectPane(c2, 'p1'), 'p1')).toEqual(disconnectPane(c2, 'p1'));
  });

  it('lets one session feed many panes', () => {
    let p = withTwo().panes;
    p = connectPane(p, 'p1', { sessionId: 'sX', agentId: null });
    p = connectPane(p, 'p2', { sessionId: 'sX', agentId: null });
    expect(panesShowing(p, 'sX', null).map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(panesShowing(p, 'sX', 'a1')).toHaveLength(0);
  });

  it('focus raises z and topPane is the most recently focused', () => {
    const { panes } = withTwo();
    expect(topPane(panes)?.id).toBe('p2');
    const f = focusPane(panes, 'p1');
    expect(topPane(f)?.id).toBe('p1');
    expect(focusPane(f, 'p1')).toBe(f);
    expect(topPane([])).toBeNull();
  });

  it('prunes connections to vanished sessions but keeps the pane', () => {
    let p = withTwo().panes;
    p = connectPane(p, 'p1', { sessionId: 'gone', agentId: 'a' });
    const out = prunePanes(p, new Set(['s2']));
    expect(out).toHaveLength(2);
    expect(out[0].source).toBeNull();
    expect(out[1].source).toEqual({ sessionId: 's2', agentId: null });
    expect(prunePanes(out, new Set(['s2']))).toBe(out);
  });
});

describe('migration from cr-layout-v2', () => {
  it('turns pane1 / pane2 into two unplaced, auto-connecting panes', () => {
    const out = migrateFromV2(applyPreset2('standard'));
    expect(out.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(out.every((p) => p.auto && p.unplaced && p.source === null)).toBe(true);
  });

  it('skips a pane the user had hidden', () => {
    const out = migrateFromV2(setHidden(applyPreset2('standard'), 'pane2', true));
    expect(out).toHaveLength(1);
  });

  it('loadPanes migrates when there is no v2b entry, and reads v2b afterwards', () => {
    const st = store({ [STORAGE_KEY_V2]: JSON.stringify(applyPreset2('standard')) });
    const first = loadPanes(st);
    expect(first).toHaveLength(2);
    expect(savePanes(first, st)).toBe(true);
    expect(Object.keys(st.data)).toContain(PANES_KEY);
    expect(loadPanes(st)).toEqual(first);
  });

  it('a saved empty list stays empty (the user closed every pane)', () => {
    const st = store();
    savePanes([], st);
    expect(loadPanes(st)).toEqual([]);
  });

  it('survives bad JSON, bad shapes and duplicate ids', () => {
    expect(loadPanes(store({ [PANES_KEY]: '{oops' }))).toEqual([]);
    const bad = { panes: [{ id: 'p1', x: 'a', y: 0, w: 10, h: 10 }, { id: 'p2', x: 1, y: 2, w: 400, h: 300, z: 3, source: { sessionId: 's', agentId: 7 } }, { id: 'p2', x: 0, y: 0, w: 400, h: 300 }] };
    const out = loadPanes(store({ [PANES_KEY]: JSON.stringify(bad) }));
    expect(out).toHaveLength(1);
    expect(out[0].source).toEqual({ sessionId: 's', agentId: null });
    const throwing: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadPanes(throwing)).toEqual([]);
    expect(savePanes([], throwing)).toBe(false);
  });

  it('migrated panes take a running session each, not one another pane already shows', () => {
    const migrated = migrateFromV2(applyPreset2('standard'));
    const list = [
      { sessionId: 'idle1', status: 'idle' },
      { sessionId: 'run1', status: 'running' },
      { sessionId: 'wait1', status: 'waiting' },
    ];
    const out = autoConnect(migrated, list);
    expect(out.map((p) => p.source?.sessionId)).toEqual(['run1', 'wait1']);
    expect(out.every((p) => !p.auto)).toBe(true);
    expect(autoConnect(out, list)).toBe(out);
    // no live sessions yet: wait
    expect(autoConnect(migrated, [])).toBe(migrated);
    // fewer active sessions than panes: the flag is cleared anyway so a later disconnect sticks
    const few = autoConnect(migrated, [{ sessionId: 'only', status: 'running' }]);
    expect(few.map((p) => p.source?.sessionId ?? null)).toEqual(['only', null]);
    expect(few.every((p) => !p.auto)).toBe(true);
  });

  it('places unplaced panes right of the graph without overlapping it or each other', () => {
    const layout = layoutCanvas([sess('a', agents('a', 3)), sess('b')], { now: NOW });
    const out = placeUnplaced(migrateFromV2(applyPreset2('standard')), layout);
    const graphRight = Math.max(...allBoxes(layout).map((b) => b.x + b.w));
    for (const p of out) {
      expect(p.unplaced).toBeUndefined();
      expect(p.x).toBeGreaterThanOrEqual(graphRight);
    }
    expect(overlap(paneBox(out[0]), paneBox(out[1]))).toBe(false);
    expect(placeUnplaced(out, layout)).toBe(out);
  });
});

describe('placement', () => {
  const obstacle: Box = { x: 100, y: 0, w: 200, h: 400 };

  it('keeps a free start', () => {
    expect(findFreeSpot({ w: 100, h: 100 }, { x: 1000, y: 10 }, [obstacle])).toEqual({ x: 1000, y: 10 });
  });

  it('moves down past an obstacle, and never overlaps', () => {
    const at = findFreeSpot({ w: 100, h: 100 }, { x: 120, y: 10 }, [obstacle]);
    expect(overlap({ x: at.x, y: at.y, w: 100, h: 100 }, obstacle)).toBe(false);
    expect(at.y).toBeGreaterThan(400);
  });

  it('puts a pane right of the session that feeds it, clear of other panes', () => {
    const layout = layoutCanvas([sess('a', agents('a', 2)), sess('b')], { now: NOW });
    const start = startNextTo(layout, 'b');
    expect(start).not.toBeNull();
    const card = layout.sessions[1].card;
    expect(start!.x).toBeGreaterThan(card.x + CARD_W);
    expect(start!.y).toBe(card.y);
    expect(startNextTo(layout, 'nope')).toBeNull();
    const first = addPane([], { x: start!.x, y: start!.y });
    const spot = findFreeSpot({ w: PANE_W, h: PANE_H }, start!, placementObstacles(layout, first.panes));
    expect(overlap({ x: spot.x, y: spot.y, w: PANE_W, h: PANE_H }, paneBox(first.panes[0]))).toBe(false);
  });

  it('falls back to the right of everything when nothing is free', () => {
    const wall: Box = { x: 0, y: -100000, w: 500, h: 400000 };
    const at = findFreeSpot({ w: 100, h: 100 }, { x: 10, y: 0 }, [wall]);
    expect(at.x).toBeGreaterThanOrEqual(500);
  });
});

describe('viewport culling and compact view', () => {
  const view = { x: 0, y: 0, k: 1 };
  it('treats panes near the viewport as visible and far ones as not', () => {
    const size = { w: 1000, h: 600 };
    expect(paneVisible({ x: 100, y: 100, w: 300, h: 300 }, view, size)).toBe(true);
    expect(paneVisible({ x: 1100, y: 0, w: 300, h: 300 }, view, size)).toBe(true); // inside the margin
    expect(paneVisible({ x: 5000, y: 0, w: 300, h: 300 }, view, size)).toBe(false);
    expect(paneVisible({ x: -2000, y: 0, w: 300, h: 300 }, view, size)).toBe(false);
    expect(paneVisible({ x: 5000, y: 0, w: 300, h: 300 }, { x: -4800, y: 0, k: 1 }, size)).toBe(true);
  });

  it('switches to the compact view below the threshold', () => {
    expect(isCompactZoom(COMPACT_ZOOM - 0.01)).toBe(true);
    expect(isCompactZoom(COMPACT_ZOOM)).toBe(false);
    expect(isCompactZoom(1)).toBe(false);
  });

  it('lastLine prefers the thought, then the newest non-empty timeline line', () => {
    expect(lastLine({ thought: ' กำลังทำ ', timeline: [{ text: 'x' }] })).toBe('กำลังทำ');
    expect(lastLine({ thought: '', timeline: [{ text: 'a' }, { text: 'b\nc' }, { text: '  ' }] })).toBe('b');
    expect(lastLine({ thought: '', timeline: [] })).toBe('');
  });
});

describe('level of detail', () => {
  it('picks the level by zoom', () => {
    expect(lodFor(2)).toBe('full');
    expect(lodFor(FULL_ZOOM)).toBe('full');
    expect(lodFor(FULL_ZOOM - 0.01)).toBe('mid');
    expect(lodFor(COMPACT_ZOOM)).toBe('mid');
    expect(lodFor(COMPACT_ZOOM - 0.01)).toBe('compact');
    expect(lodFor(0.05)).toBe('compact');
  });

  it('counter-scales labels so they stay >= 11px on screen until the cap, and never shrink in world units', () => {
    expect(labelScale(1)).toBe(1);
    expect(labelScale(2.5)).toBe(1);
    for (const k of [0.6, 0.45, 0.3, 0.2]) {
      const px = labelPx(k, 13) * k;
      expect(px).toBeGreaterThanOrEqual(MIN_LABEL_PX - 0.05);
      expect(labelPx(k, 13)).toBeGreaterThanOrEqual(13);
    }
    expect(labelScale(0.05)).toBe(MAX_LABEL_SCALE);
    expect(labelScale(0)).toBe(1);
    // grows monotonically as you zoom out
    expect(labelScale(0.3)).toBeGreaterThan(labelScale(0.5));
  });

  it('snaps view offsets to whole device pixels', () => {
    expect(snapToPixel(10.4, 1)).toBe(10);
    expect(snapToPixel(10.3, 2)).toBe(10.5);
    expect(snapToPixel(7.7, 0)).toBe(8);
  });
});

describe('wires', () => {
  const layout = layoutCanvas([sess('s1', agents('s1', 2)), sess('s2')], { now: NOW });
  const mk = (): PaneNode[] => {
    let p = addPane([], { x: 900, y: 0 }).panes;
    p = addPane(p, { x: 900, y: 600 }).panes;
    return p;
  };

  it('leaves a session at its output port and a subagent at its circle', () => {
    const s1 = layout.sessions[0];
    expect(sourcePoint(layout, { sessionId: 's1', agentId: null })).toEqual({ x: s1.card.x + CARD_W, y: s1.card.y + CARD_H / 2 });
    const circle = s1.subs.find((b) => b.agentId === 's1-a0')!;
    const pt = sourcePoint(layout, { sessionId: 's1', agentId: 's1-a0' })!;
    expect(pt.x).toBeGreaterThan(circle.box.x + circle.box.w / 2);
    expect(pt.y).toBeGreaterThanOrEqual(circle.box.y);
    // an agent that is not drawn falls back to the session port
    expect(sourcePoint(layout, { sessionId: 's1', agentId: 'missing' })).toEqual({ x: s1.card.x + CARD_W, y: s1.card.y + CARD_H / 2 });
    expect(sourcePoint(layout, { sessionId: 'nope', agentId: null })).toBeNull();
  });

  it('draws one wire per connected pane, into its left-edge port', () => {
    let p = mk();
    p = connectPane(p, 'p1', { sessionId: 's1', agentId: null });
    const w = paneWires(layout, p);
    expect(w).toHaveLength(1);
    expect(w[0].to).toEqual(paneIn(p[0]));
    expect(w[0].d.startsWith('M ')).toBe(true);
    expect(paneWire(layout, p[1])).toBeNull();
    expect(paneWire(layout, { ...p[0], source: { sessionId: 'gone', agentId: null } })).toBeNull();
  });

  it('hit-tests panes, topmost first, including the port just outside the left edge', () => {
    let p = mk();
    expect(hitPane(p, { x: 1000, y: 100 })).toBe('p1');
    expect(hitPane(p, { x: 895, y: 200 })).toBe('p1'); // on the port
    expect(hitPane(p, { x: 800, y: 200 })).toBeNull();
    expect(hitPane(p, { x: 1000, y: 700 })).toBe('p2');
    p = addPane(p, { x: 1000, y: 100 }).panes; // p3 overlaps p1 and is on top
    expect(hitPane(p, { x: 1100, y: 150 })).toBe('p3');
    p = focusPane(p, 'p1');
    expect(hitPane(p, { x: 1100, y: 150 })).toBe('p1');
  });

  it('drops on a pane connect, on empty canvas create, on another node do nothing', () => {
    const p = mk();
    expect(dropTarget(p, { x: 1000, y: 100 }, false)).toEqual({ kind: 'pane', id: 'p1' });
    expect(dropTarget(p, { x: 1000, y: 100 }, true)).toEqual({ kind: 'pane', id: 'p1' }); // a pane is above nodes
    expect(dropTarget(p, { x: 50, y: 50 }, false)).toEqual({ kind: 'empty', at: { x: 50, y: 50 } });
    expect(dropTarget(p, { x: 50, y: 50 }, true)).toEqual({ kind: 'none' });
    expect(paneAtDrop({ x: 50, y: 50 }, 400)).toEqual({ x: 50, y: -150 });
  });

  it('only counts a gesture as a wire drag past the threshold', () => {
    expect(isWireDrag(1, 1)).toBe(false);
    expect(isWireDrag(5, 0)).toBe(true);
  });

  it('puts the delete button on the curve between the two ends', () => {
    const m = wireMid({ x: 0, y: 0 }, { x: 200, y: 100 });
    expect(m).toEqual({ x: 100, y: 50 });
    const m2 = wireMid({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(m2.y).toBe(0);
    expect(m2.x).toBeGreaterThan(0);
  });
});

describe('click routing', () => {
  const panes = (): PaneNode[] => {
    let p = addPane([], { x: 0, y: 0, source: { sessionId: 's1', agentId: null } }).panes;
    p = addPane(p, { x: 600, y: 0, source: { sessionId: 's1', agentId: null } }).panes;
    p = addPane(p, { x: 0, y: 600, source: { sessionId: 's1', agentId: 'a1' } }).panes;
    return p;
  };

  it('opens the drawer when no pane is connected to the block', () => {
    expect(routeClick([], 's1', null)).toEqual({ kind: 'drawer' });
    expect(routeClick(panes(), 's9', null)).toEqual({ kind: 'drawer' });
    expect(routeClick(panes(), 's1', 'a2')).toEqual({ kind: 'drawer' });
  });

  it('focuses the connected pane, the most recently focused one when several show it', () => {
    expect(routeClick(panes(), 's1', 'a1')).toEqual({ kind: 'focus', paneId: 'p3' });
    expect(routeClick(panes(), 's1', null)).toEqual({ kind: 'focus', paneId: 'p2' });
    const re = focusPane(panes(), 'p1');
    expect(routeClick(re, 's1', null)).toEqual({ kind: 'focus', paneId: 'p1' });
  });

  it('a session click does not match a pane that shows one of its subagents', () => {
    const only = addPane([], { x: 0, y: 0, source: { sessionId: 's1', agentId: 'a1' } }).panes;
    expect(routeClick(only, 's1', null)).toEqual({ kind: 'drawer' });
  });

  it('ignores panes that are not placed yet', () => {
    const p: PaneNode[] = [{ id: 'p1', x: 0, y: 0, w: 400, h: 300, z: 1, source: { sessionId: 's1', agentId: null }, unplaced: true }];
    expect(routeClick(p, 's1', null)).toEqual({ kind: 'drawer' });
  });
});

describe('session grid', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => sess(`m${i}`, agents(`m${i}`, 8)));

  it('keeps up to MAX_PER_COL sessions in one column', () => {
    const l = layoutCanvas(many(MAX_PER_COL), { now: NOW });
    expect(new Set(l.sessions.map((s) => s.card.x)).size).toBe(1);
  });

  it('starts a new column to the right after MAX_PER_COL sessions, back at the top', () => {
    const l = layoutCanvas(many(12), { now: NOW });
    const xs = [...new Set(l.sessions.map((s) => s.card.x))];
    expect(xs).toHaveLength(3);
    expect(xs[1] - xs[0]).toBe(SESSION_COL_W);
    expect(l.sessions[MAX_PER_COL].card.y).toBe(0);
    expect(l.sessions[MAX_PER_COL].card.x).toBeGreaterThan(l.sessions[0].card.x);
    expect(l.sessions[MAX_PER_COL - 1].card.y).toBeGreaterThan(0);
  });

  it('has no overlapping boxes with 15 sessions x 8 subagents, and is wider than tall-per-column', () => {
    const l = layoutCanvas(many(15), { now: NOW });
    const boxes = allBoxes(l);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${i} vs ${j}`).toBe(false);
    }
    const single = layoutCanvas(many(15), { now: NOW, perCol: 15 });
    expect(l.bounds.h).toBeLessThan(single.bounds.h / 2);
    expect(l.bounds.w / l.bounds.h).toBeGreaterThan(single.bounds.w / single.bounds.h);
  });

  it('keeps the machine left of every card', () => {
    const l = layoutCanvas(many(12), { now: NOW });
    for (const s of l.sessions) expect(l.machine.x + l.machine.w).toBeLessThanOrEqual(s.card.x);
  });
});

describe('view tween and framing', () => {
  it('tweens from a to b and lands exactly', () => {
    const a = { x: 0, y: 0, k: 0.5 };
    const b = { x: 100, y: -40, k: 2 };
    expect(tweenView(a, b, 0)).toEqual(a);
    const end = tweenView(a, b, 1);
    expect(end.x).toBeCloseTo(100);
    expect(end.y).toBeCloseTo(-40);
    expect(end.k).toBeCloseTo(2);
    const mid = tweenView(a, b, 0.5);
    expect(mid.k).toBeGreaterThan(0.5);
    expect(mid.k).toBeLessThan(2);
  });

  it('centres a box in the visible area and never zooms in past maxZoom', () => {
    const size = { w: 1000, h: 600 };
    const v = viewForBox({ x: 1000, y: 1000, w: 400, h: 300 }, size, { maxZoom: 1 });
    expect(v.k).toBeLessThanOrEqual(1);
    expect(1200 * v.k + v.x).toBeCloseTo(500);
    expect(1150 * v.k + v.y).toBeCloseTo(300);
    const huge = viewForBox({ x: 0, y: 0, w: 8000, h: 6000 }, size, { maxZoom: 1 });
    expect(huge.k).toBeLessThan(0.2);
  });
});
