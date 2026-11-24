import { describe, expect, it } from 'vitest';
import { MACHINE_KEY, allBoxes, layoutCanvas, modelKey, type Box, type CanvasLayout, type CanvasSession, type StoredPositions } from './canvasLayout';
import { machineKey } from './machineLayout';
import { PANE_H, PANE_W, type PaneNode } from './paneStore';
import { PLACE_MARGIN, fitBoundsOf, liveOverride, overlapRatio, placeMachines, relayoutPanes, resolvePanes, resolvePlacement, sessionBlock, withMachines } from './placement';

const NOW = 1_700_000_000_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const hit = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sess = (n: number, subs = 0): CanvasSession[] =>
  Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, subagents: Array.from({ length: subs }, (_, j) => ({ id: `a${j}`, status: 'running' })) }));
const auto = (n: number, subs = 0): CanvasLayout => layoutCanvas(sess(n, subs), { now: NOW });

describe('resolvePlacement', () => {
  it('leaves the automatic layout untouched when nothing is stored', () => {
    const a = auto(7, 3);
    const r = resolvePlacement(a, {});
    expect(r.sessions.map((s) => s.card)).toEqual(a.sessions.map((s) => s.card));
  });

  it('moves a fresh session out of the slot a dragged card sits in', () => {
    const a = auto(3);
    const stored: StoredPositions = { s2: { x: a.sessions[0].card.x, y: a.sessions[0].card.y } };
    const r = resolvePlacement(a, stored);
    expect(r.sessions[2].card).toMatchObject({ x: stored.s2.x, y: stored.s2.y });
    const blocks = r.sessions.map(sessionBlock);
    expect(hit(blocks[0], blocks[2])).toBe(false);
    expect(hit(blocks[1], blocks[2])).toBe(false);
    expect(hit(blocks[0], blocks[1])).toBe(false);
  });

  it('keeps at most 5 auto-placed sessions per column', () => {
    const a = auto(12, 2);
    const stored: StoredPositions = { s0: { x: a.sessions[0].card.x, y: a.sessions[0].card.y + 40 } };
    const r = resolvePlacement(a, stored);
    const cols = new Map<number, number>();
    for (const s of r.sessions) if (!stored[s.sessionId]) cols.set(s.card.x, (cols.get(s.card.x) ?? 0) + 1);
    for (const n of cols.values()) expect(n).toBeLessThanOrEqual(5);
  });

  it('nudges a dragged session that sits exactly on another dragged one, never the first', () => {
    const a = auto(2);
    const stored: StoredPositions = { s0: { x: 500, y: 300 }, s1: { x: 500, y: 300 } };
    const r = resolvePlacement(a, stored);
    expect(r.sessions[0].card).toMatchObject({ x: 500, y: 300 });
    expect(r.sessions[1].card.x).toBe(500);
    expect(r.sessions[1].card.y).toBeGreaterThan(300);
    expect(hit(sessionBlock(r.sessions[0]), sessionBlock(r.sessions[1]))).toBe(false);
  });

  it('does not touch dragged sessions that only overlap lightly', () => {
    const a = auto(2);
    const stored: StoredPositions = { s0: { x: 500, y: 300 }, s1: { x: 700, y: 370 } };
    const r = resolvePlacement(a, stored);
    expect(r.sessions[1].card).toMatchObject({ x: 700, y: 370 });
  });

  it('counts a dragged round node (offset) in the block of its session', () => {
    const a = auto(2);
    const stored: StoredPositions = { [modelKey('s0')]: { x: 3000, y: 0 } };
    const r = resolvePlacement(a, stored);
    expect(sessionBlock(r.sessions[0]).x + sessionBlock(r.sessions[0]).w).toBeGreaterThan(3000);
    expect(hit(sessionBlock(r.sessions[0]), sessionBlock(r.sessions[1]))).toBe(false);
  });

  it('20 random scenes: no free node intersects any other node, stored nodes stay put', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rnd = rng(seed);
      const n = 2 + Math.floor(rnd() * 14);
      const a = layoutCanvas(
        Array.from({ length: n }, (_, i) => ({
          sessionId: `s${i}`,
          subagents: Array.from({ length: Math.floor(rnd() * 9) }, (_, j) => ({ id: `a${j}`, status: 'running' })),
        })),
        { now: NOW },
      );
      const stored: StoredPositions = {};
      a.sessions.forEach((s, i) => {
        const r = rnd();
        if (r < 0.35) {
          const t = a.sessions[Math.floor(rnd() * a.sessions.length)];
          stored[s.sessionId] = r < 0.2 ? { x: t.card.x + rnd() * 60, y: t.card.y + rnd() * 60 } : { x: rnd() * 3000, y: rnd() * 1500 };
        }
        if (rnd() < 0.15 && s.subs.length > 1) stored[s.subs[1].key] = { x: (rnd() - 0.5) * 600, y: rnd() * 300 };
        if (i === 0 && rnd() < 0.3) stored[MACHINE_KEY] = { x: -200, y: 100 };
      });
      const r = resolvePlacement(a, stored);
      r.sessions.forEach((s, i) => {
        const at = stored[s.sessionId];
        if (at) expect(s.card.x).toBe(at.x);
        for (let j = 0; j < i; j++) {
          const o = r.sessions[j];
          if (!at || !stored[o.sessionId]) {
            const g = sessionBlock(s);
            const grown = { x: g.x - PLACE_MARGIN + 1, y: g.y - PLACE_MARGIN + 1, w: g.w + 2 * PLACE_MARGIN - 2, h: g.h + 2 * PLACE_MARGIN - 2 };
            expect(hit(grown, sessionBlock(o))).toBe(false);
          } else {
            expect(overlapRatio(sessionBlock(s), sessionBlock(o))).toBeLessThanOrEqual(0.5);
          }
        }
      });
    }
  });
});

describe('placeMachines', () => {
  it('stacks machines under the local node, skipping a stored session block that sits there', () => {
    const a = auto(2);
    const lay = resolvePlacement(a, {});
    const free = placeMachines([{ id: 'm1' }, { id: 'm2' }], lay.machine, lay, {});
    expect(free[0].box.y).toBeGreaterThan(lay.machine.y + lay.machine.h);
    expect(hit(free[0].box, free[1].box)).toBe(false);

    const stored: StoredPositions = { s0: { x: lay.machine.x - 10, y: lay.machine.y + lay.machine.h + 40 } };
    const lay2 = resolvePlacement(a, stored);
    const ms = placeMachines([{ id: 'm1' }], lay2.machine, lay2, stored);
    expect(hit(ms[0].box, sessionBlock(lay2.sessions[0]))).toBe(false);
  });

  it('keeps a dragged machine where it is', () => {
    const lay = resolvePlacement(auto(1), {});
    const ms = placeMachines([{ id: 'm1' }], lay.machine, lay, { [machineKey('m1')]: { x: 5, y: 6 } });
    expect(ms[0].box).toMatchObject({ x: 5, y: 6 });
  });
});

const pane = (id: string, x: number, y: number, sid: string | null, extra: Partial<PaneNode> = {}): PaneNode => ({
  id,
  x,
  y,
  w: PANE_W,
  h: PANE_H,
  z: 1,
  source: sid ? { sessionId: sid, agentId: null } : null,
  ...extra,
});

function fullLayout(n: number, subs: number): CanvasLayout {
  const base = resolvePlacement(auto(n, subs), {});
  return withMachines(base, placeMachines([{ id: 'm1' }], base.machine, base, {}));
}

describe('panes', () => {
  it('resolvePanes moves a pane lying on a card and keeps clean ones', () => {
    const lay = fullLayout(3, 2);
    const c = lay.sessions[1].card;
    const bad = pane('p1', c.x + 10, c.y + 10, 's1');
    const farRight = allBoxes(lay).reduce((m, b) => Math.max(m, b.x + b.w), 0) + 400;
    const good = pane('p2', farRight, 0, null);
    const out = resolvePanes([bad, good], lay);
    expect(out[1]).toBe(good);
    for (const b of allBoxes(lay)) expect(hit(out[0], b)).toBe(false);
  });

  it('relayoutPanes keeps connections and leaves no pane on a node or on another pane', () => {
    const lay = fullLayout(8, 4);
    const panes = [pane('p1', 0, 0, 's0'), pane('p2', 10, 10, 's1'), pane('p3', 20, 20, 's1'), pane('p4', 30, 30, null), pane('p5', 40, 40, 'gone', { z: 5 })];
    const out = relayoutPanes(panes, lay);
    expect(out.map((p) => p.source)).toEqual(panes.map((p) => p.source));
    expect(out.map((p) => p.z)).toEqual(panes.map((p) => p.z));
    const graph = allBoxes(lay);
    out.forEach((p, i) => {
      for (const b of graph) expect(hit(p, b)).toBe(false);
      for (let j = 0; j < i; j++) expect(hit(p, out[j])).toBe(false);
    });
  });
});

describe('fit bounds', () => {
  it('include every card, caption, circle, machine node and placed pane', () => {
    const base = resolvePlacement(auto(9, 5), { s1: { x: -900, y: 2000 } });
    const lay = withMachines(base, placeMachines([{ id: 'm1' }, { id: 'm2' }], base.machine, base, {}));
    const panes = [pane('p1', 4000, -300, 's0'), pane('p2', 9999, 9999, null, { unplaced: true })];
    const b = fitBoundsOf(lay, panes);
    const inside = (x: Box) => x.x >= b.x && x.y >= b.y && x.x + x.w <= b.x + b.w && x.y + x.h <= b.y + b.h;
    for (const x of allBoxes(lay)) expect(inside(x)).toBe(true);
    expect(inside(panes[0])).toBe(true);
    expect(b.x + b.w).toBeLessThan(9999);
  });
});

describe('liveOverride', () => {
  it('turns a live drag into a position (cards, machines) or an offset difference (round nodes)', () => {
    const settled: StoredPositions = { s0: { x: 1, y: 2 }, [modelKey('s0')]: { x: 10, y: 10 } };
    const live: StoredPositions = { s0: { x: 1, y: 2 }, s1: { x: 7, y: 8 }, [modelKey('s0')]: { x: 15, y: 4 }, [modelKey('s1')]: { x: 3, y: 3 } };
    expect(liveOverride(live, settled)).toEqual({ s1: { x: 7, y: 8 }, [modelKey('s0')]: { x: 5, y: -6 }, [modelKey('s1')]: { x: 3, y: 3 } });
  });
});
