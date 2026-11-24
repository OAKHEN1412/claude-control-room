// Regression: boxes must not move by themselves (Enter / click / new activity). Once a node has a position it keeps it.
import { describe, expect, it } from 'vitest';
import { layoutCanvas, type CanvasSession, type StoredPositions } from './canvasLayout';
import { persistAutoPlacement, placeMachines, resolvePlacement, withMachines } from './placement';

const NOW = 1_700_000_000_000;
const sess = (ids: string[], subs: Record<string, number> = {}): CanvasSession[] =>
  ids.map((id) => ({ sessionId: id, subagents: Array.from({ length: subs[id] ?? 0 }, (_, j) => ({ id: `a${j}`, status: 'running' })) }));

/** One render of the canvas: place on the stored positions, then remember what was placed. */
function step(stored: StoredPositions, sessions: CanvasSession[], machines: { id: string }[] = []) {
  const auto = layoutCanvas(sessions, { now: NOW });
  const lay = resolvePlacement(auto, stored, { separateStored: false });
  const ms = placeMachines(machines, lay.machine, lay, stored);
  const next = persistAutoPlacement(stored, lay, ms);
  return { lay, ms, next, full: withMachines(lay, ms) };
}
const cards = (l: ReturnType<typeof step>) => Object.fromEntries(l.lay.sessions.map((s) => [s.sessionId, { x: s.card.x, y: s.card.y }]));

describe('placement is sticky', () => {
  it('a reorder of the sessions moves nothing', () => {
    const a = step({}, sess(['a', 'b', 'c', 'd']), [{ id: 'm1' }]);
    const b = step(a.next, sess(['c', 'a', 'd', 'b']), [{ id: 'm1' }]);
    expect(cards(b)).toEqual(cards(a));
    expect(b.lay.machine).toEqual(a.lay.machine);
    expect(b.ms).toEqual(a.ms);
  });

  it('a new session at the front (most recent first) takes a free slot and moves nobody', () => {
    const a = step({}, sess(['a', 'b', 'c']));
    const b = step(a.next, sess(['n', 'a', 'b', 'c']));
    for (const id of ['a', 'b', 'c']) expect(cards(b)[id]).toEqual(cards(a)[id]);
    expect(b.lay.machine).toEqual(a.lay.machine);
  });

  it('a session growing more subagent rows does not move the others (even below it)', () => {
    const a = step({}, sess(['a', 'b', 'c'], { a: 0 }));
    const b = step(a.next, sess(['a', 'b', 'c'], { a: 8 }));
    expect(cards(b)).toEqual(cards(a));
    expect(b.lay.machine).toEqual(a.lay.machine);
  });

  it('a session going away does not pull the others up', () => {
    const a = step({}, sess(['a', 'b', 'c', 'd']));
    const b = step(a.next, sess(['a', 'c', 'd']));
    for (const id of ['a', 'c', 'd']) expect(cards(b)[id]).toEqual(cards(a)[id]);
  });

  it('without remembering (the old behaviour) a reorder does move boxes', () => {
    const a = step({}, sess(['a', 'b', 'c', 'd']));
    const b = step({}, sess(['c', 'a', 'd', 'b']));
    expect(cards(b)).not.toEqual(cards(a));
  });

  it('the settled result is a fixed point', () => {
    const a = step({}, sess(['a', 'b']), [{ id: 'm1' }, { id: 'm2' }]);
    expect(persistAutoPlacement(a.next, a.lay, a.ms)).toBe(a.next);
  });
});
