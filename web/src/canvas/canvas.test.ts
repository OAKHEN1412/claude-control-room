import { describe, expect, it } from 'vitest';
import {
  CARD_H,
  CARD_W,
  CIRCLE,
  MACHINE_KEY,
  MAX_SUBS,
  RECENT_MS,
  agentKey,
  allBoxes,
  applyPositions,
  canvasEdges,
  circleTop,
  keySession,
  layoutCanvas,
  modelKey,
  modelWord,
  moreKey,
  pickAgents,
  type Box,
  type CanvasAgent,
  type CanvasSession,
} from './canvasLayout';
import { POSITIONS_KEY, loadPositions, prunePositions, savePositions, type StorageLike } from './canvasStore';
import { MAX_ZOOM, MIN_ZOOM, fitView, screenToWorld, zoomAt } from './viewport';

const NOW = 1_000_000_000_000;
const MIN = 60_000;

const agents = (sid: string, n: number, over: Partial<CanvasAgent> = {}): CanvasAgent[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${sid}-a${i}`, status: 'running', finished: false, lastActivity: NOW - i, ...over }));

const sess = (id: string, subs: CanvasAgent[] = []): CanvasSession => ({ sessionId: id, subagents: subs });

const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function store(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v) };
}

describe('pickAgents', () => {
  it('shows recent agents and folds the old ones', () => {
    const list: CanvasAgent[] = [
      { id: 'new', status: 'done', lastActivity: NOW - MIN },
      { id: 'old', status: 'done', lastActivity: NOW - RECENT_MS - MIN },
    ];
    const r = pickAgents(list, NOW, false);
    expect(r.shown.map((a) => a.id)).toEqual(['new']);
    expect(r.hidden).toBe(1);
  });

  it('caps at MAX_SUBS, preferring running agents, and keeps input order', () => {
    const list = [...agents('x', 6, { status: 'done', lastActivity: NOW - 1000 }), ...agents('y', 5)];
    const r = pickAgents(list, NOW, false);
    expect(r.shown).toHaveLength(MAX_SUBS);
    expect(r.hidden).toBe(3);
    for (const a of list.filter((x) => x.id.startsWith('y'))) expect(r.shown.map((s) => s.id)).toContain(a.id);
    const order = r.shown.map((a) => list.indexOf(a));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('shows everything when expanded', () => {
    const list = agents('x', 12);
    expect(pickAgents(list, NOW, true)).toEqual({ shown: list, hidden: 0 });
  });
});

describe('layoutCanvas', () => {
  const input = [sess('s1', agents('s1', 3)), sess('s2'), sess('s3', agents('s3', 11)), sess('s4', agents('s4', 8))];

  it('is deterministic', () => {
    expect(layoutCanvas(input, { now: NOW })).toEqual(layoutCanvas(input, { now: NOW }));
  });

  it('is empty with no sessions', () => {
    const l = layoutCanvas([], { now: NOW });
    expect(l.empty).toBe(true);
    expect(l.sessions).toHaveLength(0);
  });

  it('has no overlapping boxes (machine, cards, captions, round nodes)', () => {
    for (const set of [input, Array.from({ length: 15 }, (_, i) => sess(`m${i}`, agents(`m${i}`, 8)))]) {
      const boxes = allBoxes(layoutCanvas(set, { now: NOW }));
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${i} vs ${j}`).toBe(false);
      }
    }
  });

  it('keeps the machine left of the cards and every round node under its own card', () => {
    const l = layoutCanvas(input, { now: NOW });
    for (const s of l.sessions) {
      expect(l.machine.x + l.machine.w).toBeLessThanOrEqual(s.card.x);
      for (const b of s.subs) {
        expect(b.box.y, b.key).toBeGreaterThanOrEqual(s.card.y + CARD_H);
        expect(b.box.x, b.key).toBeGreaterThanOrEqual(s.card.x);
      }
    }
  });

  it('stacks sessions top to bottom without a session reaching into the next block', () => {
    const l = layoutCanvas(input, { now: NOW });
    for (let i = 0; i + 1 < l.sessions.length; i++) {
      const lowest = Math.max(...l.sessions[i].subs.map((b) => b.box.y + b.box.h));
      expect(l.sessions[i + 1].card.y).toBeGreaterThan(lowest);
    }
  });

  it('always has exactly one model node first, then one circle per subagent', () => {
    const l = layoutCanvas([sess('a', agents('a', 3))], { now: NOW });
    const kinds = l.sessions[0].subs.map((b) => b.kind);
    expect(kinds).toEqual(['model', 'agent', 'agent', 'agent']);
    expect(l.sessions[0].subs[0].key).toBe(modelKey('a'));
  });

  it('shows 8 subagents and a +N circle for the rest', () => {
    const l = layoutCanvas([sess('a', agents('a', 11))], { now: NOW });
    const subs = l.sessions[0].subs;
    expect(subs.filter((b) => b.kind === 'agent')).toHaveLength(MAX_SUBS);
    const more = subs.find((b) => b.kind === 'more');
    expect(more?.count).toBe(3);
    expect(more?.key).toBe(moreKey('a'));
    expect(more?.expanded).toBe(false);
  });

  it('has no +N circle at exactly the cap, and expanding shows all with a hide circle', () => {
    expect(layoutCanvas([sess('a', agents('a', 8))], { now: NOW }).sessions[0].subs.some((b) => b.kind === 'more')).toBe(false);
    const open = layoutCanvas([sess('a', agents('a', 11))], { now: NOW, expanded: new Set(['a']) }).sessions[0].subs;
    expect(open.filter((b) => b.kind === 'agent')).toHaveLength(11);
    expect(open.find((b) => b.kind === 'more')?.expanded).toBe(true);
  });

  it('wraps round nodes into rows and grows the block', () => {
    const one = layoutCanvas([sess('a', agents('a', 2)), sess('b')], { now: NOW });
    const two = layoutCanvas([sess('a', agents('a', 8)), sess('b')], { now: NOW });
    expect(two.sessions[1].card.y).toBeGreaterThan(one.sessions[1].card.y);
  });

  it('centres the machine on its sessions', () => {
    const l = layoutCanvas([sess('a'), sess('b')], { now: NOW });
    const mid = (l.sessions[0].card.y + l.sessions[1].card.y + CARD_H) / 2;
    const shapeMid = l.machine.y + 72 + 42;
    expect(Math.abs(shapeMid - mid)).toBeLessThan(1);
  });
});

describe('applyPositions', () => {
  const base = layoutCanvas([sess('a', agents('a', 2)), sess('b')], { now: NOW });

  it('moves a session with its caption, ports and round nodes', () => {
    const s = base.sessions[0];
    const out = applyPositions(base, { a: { x: s.card.x + 100, y: s.card.y + 40 } }).sessions[0];
    expect(out.card.x).toBe(s.card.x + 100);
    expect(out.caption.y).toBe(s.caption.y + 40);
    expect(out.modelPort.x).toBe(s.modelPort.x + 100);
    expect(out.subs.map((b) => b.box.y - 40)).toEqual(s.subs.map((b) => b.box.y));
  });

  it('treats a round node key as an offset from its slot', () => {
    const key = agentKey('a', 'a-a0');
    const moved = applyPositions(base, { [key]: { x: 10, y: -5 } }).sessions[0];
    const orig = base.sessions[0].subs.find((b) => b.key === key)!;
    const now = moved.subs.find((b) => b.key === key)!;
    expect(now.box.x).toBe(orig.box.x + 10);
    expect(now.box.y).toBe(orig.box.y - 5);
    expect(moved.card).toEqual(base.sessions[0].card);
  });

  it('moves the machine to an absolute position and leaves other sessions alone', () => {
    const out = applyPositions(base, { [MACHINE_KEY]: { x: -300, y: 20 } });
    expect(out.machine).toMatchObject({ x: -300, y: 20 });
    expect(out.sessions[1]).toEqual(base.sessions[1]);
  });

  it('does not mutate the input and updates bounds', () => {
    const copy = structuredClone(base);
    const out = applyPositions(base, { a: { x: 1000, y: 1000 } });
    expect(base).toEqual(copy);
    expect(out.bounds.x + out.bounds.w).toBeGreaterThan(base.bounds.x + base.bounds.w);
  });

  it('ignores stored keys of sessions that are not in the layout', () => {
    expect(applyPositions(base, { ghost: { x: 5, y: 5 }, 'ghost:model': { x: 1, y: 1 } })).toEqual(base);
  });
});

describe('canvasEdges', () => {
  it('has one machine edge per session and one dashed edge per round node', () => {
    const l = layoutCanvas([sess('a', agents('a', 2)), sess('b')], { now: NOW });
    const edges = canvasEdges(l);
    expect(edges.filter((e) => e.kind === 'machine')).toHaveLength(2);
    expect(edges.filter((e) => e.kind === 'model')).toHaveLength(2);
    expect(edges.filter((e) => e.kind === 'agent')).toHaveLength(2);
    expect(new Set(edges.map((e) => e.key)).size).toBe(edges.length);
  });

  it('ends a dashed edge at the top centre of its circle', () => {
    const l = layoutCanvas([sess('a', agents('a', 1))], { now: NOW });
    const sub = l.sessions[0].subs[1];
    const e = canvasEdges(l).find((x) => x.kind === 'agent')!;
    const end = circleTop(sub.box);
    expect(e.d.endsWith(`${end.x} ${end.y}`)).toBe(true);
    expect(CIRCLE).toBeLessThan(sub.box.w);
  });
});

describe('modelWord', () => {
  it('takes the family word', () => {
    expect(modelWord('claude-opus-5-5')).toBe('opus');
    expect(modelWord('sonnet')).toBe('sonnet');
    expect(modelWord('qwen3-coder')).toBe('qwen3');
    expect(modelWord(null)).toBe('?');
  });
});

describe('stored positions', () => {
  it('round-trips through storage', () => {
    const s = store();
    expect(savePositions({ a: { x: 1, y: 2 } }, s)).toBe(true);
    expect(loadPositions(s)).toEqual({ a: { x: 1, y: 2 } });
  });

  it('survives bad JSON, bad shapes and throwing storage', () => {
    expect(loadPositions(store({ [POSITIONS_KEY]: '{oops' }))).toEqual({});
    expect(loadPositions(store({ [POSITIONS_KEY]: '[1,2]' }))).toEqual({});
    expect(loadPositions(store({ [POSITIONS_KEY]: JSON.stringify({ a: { x: 'n', y: 1 }, b: { x: 3, y: 4 } }) }))).toEqual({ b: { x: 3, y: 4 } });
    const boom: StorageLike = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(loadPositions(boom)).toEqual({});
    expect(savePositions({}, boom)).toBe(false);
  });

  it('prunes sessions that are gone, with their round-node offsets, but keeps the machine', () => {
    const pos = {
      [MACHINE_KEY]: { x: 1, y: 1 },
      live: { x: 2, y: 2 },
      [modelKey('live')]: { x: 3, y: 3 },
      dead: { x: 4, y: 4 },
      [agentKey('dead', 'z')]: { x: 5, y: 5 },
    };
    const out = prunePositions(pos, new Set(['live']));
    expect(Object.keys(out).sort()).toEqual([MACHINE_KEY, 'live', modelKey('live')].sort());
  });

  it('returns the same object when there is nothing to prune', () => {
    const pos = { a: { x: 1, y: 1 } };
    expect(prunePositions(pos, new Set(['a']))).toBe(pos);
  });

  it('maps a key to its session', () => {
    expect(keySession(MACHINE_KEY)).toBeNull();
    expect(keySession('abc')).toBe('abc');
    expect(keySession(agentKey('abc', 'q'))).toBe('abc');
  });
});

describe('viewport', () => {
  it('keeps the world point under the cursor fixed while zooming', () => {
    const v = { x: 40, y: -20, k: 1 };
    const before = screenToWorld(v, { x: 300, y: 200 });
    const after = screenToWorld(zoomAt(v, 1.5, 300, 200), { x: 300, y: 200 });
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps zoom at both ends', () => {
    let v = { x: 0, y: 0, k: 1 };
    for (let i = 0; i < 50; i++) v = zoomAt(v, 1.5, 0, 0);
    expect(v.k).toBe(MAX_ZOOM);
    for (let i = 0; i < 100; i++) v = zoomAt(v, 0.5, 0, 0);
    expect(v.k).toBe(MIN_ZOOM);
  });

  it('fits bounds inside the visible area and never zooms in past 1', () => {
    const size = { w: 800, h: 600 };
    const small = fitView({ x: 0, y: 0, w: 100, h: 100 }, size);
    expect(small.k).toBe(1);
    const big = { x: -50, y: 10, w: 2000, h: 3000 };
    const v = fitView(big, size, { insetRight: 200 });
    expect(v.k).toBeLessThan(1);
    const left = big.x * v.k + v.x;
    const right = (big.x + big.w) * v.k + v.x;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(600);
    expect((big.y + big.h) * v.k + v.y).toBeLessThanOrEqual(600);
  });

  it('returns a neutral view for empty bounds', () => {
    expect(fitView({ x: 0, y: 0, w: 0, h: 0 }, { w: 800, h: 600 }).k).toBe(1);
    expect(CARD_W).toBeGreaterThan(0);
  });
});
