import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  PRESET_NAMES,
  STORAGE_KEY,
  WIDGET_IDS,
  applyPreset,
  clampRect,
  loadLayout,
  moveRect,
  resizeRect,
  saveLayout,
  snap,
  type Layout,
  type Rect,
  type StorageLike,
} from './layout';

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe('snap', () => {
  it('rounds to the 2.5% grid', () => {
    expect(snap(11)).toBe(10);
    expect(snap(12)).toBe(12.5);
    expect(snap(37.6)).toBe(37.5);
    expect(snap(50)).toBe(50);
  });
});

describe('clampRect', () => {
  it('pulls a rect with negative x/y back to the top-left edge', () => {
    expect(clampRect(rect(-5, -3, 20, 20))).toEqual(rect(0, 0, 20, 20));
  });

  it('pulls a rect that overflows the right edge back inside', () => {
    expect(clampRect(rect(95, 10, 20, 20))).toEqual(rect(80, 10, 20, 20));
  });

  it('pulls a rect that overflows the bottom edge back inside', () => {
    expect(clampRect(rect(10, 90, 20, 20))).toEqual(rect(10, 80, 20, 20));
  });

  it('caps width and height at 100', () => {
    expect(clampRect(rect(30, 30, 150, 120))).toEqual(rect(0, 0, 100, 100));
  });

  it('raises width and height to the minimum size', () => {
    expect(clampRect(rect(40, 40, 2, 3))).toEqual(rect(40, 40, 10, 10));
    expect(clampRect(rect(40, 40, 25, 4), { w: 15, h: 20 })).toEqual(rect(40, 40, 25, 20));
  });

  it('leaves an already valid rect unchanged', () => {
    expect(clampRect(rect(12.5, 25, 30, 40))).toEqual(rect(12.5, 25, 30, 40));
  });
});

describe('moveRect', () => {
  it('moves by a snapped delta', () => {
    expect(moveRect(rect(10, 10, 20, 20), 5, -5)).toEqual(rect(15, 5, 20, 20));
  });

  it('ignores a delta below half a grid step', () => {
    expect(moveRect(rect(10, 10, 20, 20), 1, 1)).toEqual(rect(10, 10, 20, 20));
  });

  it('clamps when dragged beyond the right and bottom edges', () => {
    expect(moveRect(rect(50, 50, 30, 25), 80, 80)).toEqual(rect(70, 75, 30, 25));
  });

  it('clamps when dragged beyond the top-left edges', () => {
    expect(moveRect(rect(10, 10, 30, 25), -80, -80)).toEqual(rect(0, 0, 30, 25));
  });
});

describe('resizeRect', () => {
  it('grows by a snapped delta from the bottom-right corner', () => {
    expect(resizeRect(rect(10, 10, 20, 20), 5, 2.5)).toEqual(rect(10, 10, 25, 22.5));
  });

  it('clamps width at the right edge', () => {
    expect(resizeRect(rect(60, 0, 20, 20), 100, 0).w).toBe(40);
  });

  it('clamps height at the bottom edge', () => {
    expect(resizeRect(rect(0, 70, 20, 20), 0, 100).h).toBe(30);
  });

  it('does not shrink below the minimum size', () => {
    expect(resizeRect(rect(10, 10, 20, 20), -100, -100)).toEqual(rect(10, 10, 10, 10));
  });

  it('keeps the minimum size even when the rect starts near the right edge', () => {
    const r2 = resizeRect(rect(97, 0, 3, 20), 0, 0);
    expect(r2.x).toBe(90);
    expect(r2.w).toBe(10);
    expect(r2.x + r2.w).toBe(100);
  });
});

describe('PRESETS', () => {
  it('has every widget id and every rect inside the canvas at min size or more', () => {
    for (const name of PRESET_NAMES) {
      const layout: Layout = PRESETS[name];
      for (const id of WIDGET_IDS) {
        const r = layout[id];
        expect(r.x, `${name}.${id}.x`).toBeGreaterThanOrEqual(0);
        expect(r.y, `${name}.${id}.y`).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w, `${name}.${id}.right`).toBeLessThanOrEqual(100);
        expect(r.y + r.h, `${name}.${id}.bottom`).toBeLessThanOrEqual(100);
        expect(r.w, `${name}.${id}.w`).toBeGreaterThanOrEqual(10);
        expect(r.h, `${name}.${id}.h`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('has no overlapping rects within a preset', () => {
    for (const name of PRESET_NAMES) {
      const layout = PRESETS[name];
      for (let i = 0; i < WIDGET_IDS.length; i++) {
        for (let j = i + 1; j < WIDGET_IDS.length; j++) {
          const a = layout[WIDGET_IDS[i]];
          const b = layout[WIDGET_IDS[j]];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${name}: ${WIDGET_IDS[i]} vs ${WIDGET_IDS[j]}`).toBe(false);
        }
      }
    }
  });

  it('covers the whole canvas exactly (areas sum to 10000)', () => {
    for (const name of PRESET_NAMES) {
      const total = WIDGET_IDS.reduce((s, id) => s + PRESETS[name][id].w * PRESETS[name][id].h, 0);
      expect(total, name).toBe(10000);
    }
  });
});

describe('loadLayout / saveLayout', () => {
  it('falls back to standard when the stored JSON is invalid', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: '{not json' });
    expect(loadLayout(storage)).toEqual(applyPreset('standard'));
  });

  it('falls back to standard when nothing is stored', () => {
    expect(loadLayout(fakeStorage())).toEqual(applyPreset('standard'));
  });

  it('falls back to standard when a rect is malformed', () => {
    const bad = { preset: 'custom', rects: { ...PRESETS.standard, pane1: { x: 'a', y: 0, w: 10, h: 10 } } };
    expect(loadLayout(fakeStorage({ [STORAGE_KEY]: JSON.stringify(bad) }))).toEqual(applyPreset('standard'));
  });

  it('falls back to standard when a widget id is missing', () => {
    const { clip: _omit, ...rest } = PRESETS.standard;
    const bad = { preset: 'standard', rects: rest };
    expect(loadLayout(fakeStorage({ [STORAGE_KEY]: JSON.stringify(bad) }))).toEqual(applyPreset('standard'));
  });

  it('keeps custom rects but marks an unknown preset name as custom', () => {
    const custom = { preset: 'weird', rects: PRESETS['graph-big'] };
    const loaded = loadLayout(fakeStorage({ [STORAGE_KEY]: JSON.stringify(custom) }));
    expect(loaded.preset).toBe('custom');
    expect(loaded.rects).toEqual(PRESETS['graph-big']);
  });

  it('falls back to standard when storage throws on read', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
    };
    expect(loadLayout(throwing)).toEqual(applyPreset('standard'));
  });

  it('round-trips a saved layout', () => {
    const storage = fakeStorage();
    const state = { preset: 'custom' as const, rects: { ...PRESETS.standard, graph: rect(5, 5, 45, 60) } };
    expect(saveLayout(state, storage)).toBe(true);
    expect(loadLayout(storage)).toEqual(state);
  });

  it('reports failure instead of throwing when the write is refused', () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(saveLayout(applyPreset('standard'), throwing)).toBe(false);
  });
});

describe('applyPreset', () => {
  it('returns a copy so callers cannot mutate PRESETS', () => {
    const out = applyPreset('chat-big');
    out.rects.graph.w = 1;
    expect(PRESETS['chat-big'].graph.w).toBe(35);
    expect(out.preset).toBe('chat-big');
  });
});
