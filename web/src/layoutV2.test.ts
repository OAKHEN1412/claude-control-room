import { describe, expect, it } from 'vitest';
import { STORAGE_KEY as STORAGE_KEY_V1 } from './layout';
import {
  PRESETS2,
  PRESET_HIDDEN2,
  PRESET_NAMES2,
  STORAGE_KEY_V2,
  WIDGET_IDS2,
  applyPreset2,
  coverRightPct,
  loadLayout2,
  saveLayout2,
  setHidden,
  type Rect,
  type StorageLike,
} from './layoutV2';

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
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('v2 presets', () => {
  it('has the four floating widgets and no graph widget', () => {
    expect([...WIDGET_IDS2]).toEqual(['pane1', 'pane2', 'summary', 'clip', 'saved']);
    for (const name of PRESET_NAMES2) expect(Object.keys(PRESETS2[name]).sort()).toEqual([...WIDGET_IDS2].sort());
  });

  it('keeps every rect on the board at min size or more', () => {
    for (const name of PRESET_NAMES2) {
      for (const id of WIDGET_IDS2) {
        const r = PRESETS2[name][id];
        expect(r.x, `${name}.${id}`).toBeGreaterThanOrEqual(0);
        expect(r.y, `${name}.${id}`).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w, `${name}.${id}`).toBeLessThanOrEqual(100);
        expect(r.y + r.h, `${name}.${id}`).toBeLessThanOrEqual(100);
        expect(r.w).toBeGreaterThanOrEqual(10);
        expect(r.h).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('has no overlapping rects, so showing every widget never stacks them', () => {
    for (const name of PRESET_NAMES2) {
      const shown = [...WIDGET_IDS2];
      for (let i = 0; i < shown.length; i++) {
        for (let j = i + 1; j < shown.length; j++) {
          expect(overlap(PRESETS2[name][shown[i]], PRESETS2[name][shown[j]]), `${name}: ${shown[i]} vs ${shown[j]}`).toBe(false);
        }
      }
    }
  });

  it('leaves the left half of the screen to the canvas in the default preset (panes on the right)', () => {
    expect(PRESETS2.standard.pane1.x).toBeGreaterThanOrEqual(50);
    expect(PRESETS2.standard.pane2.x).toBeGreaterThanOrEqual(50);
    expect(applyPreset2('standard').hidden.summary).toBe(true);
  });

  it('applies the hidden widgets of each preset (summary and clip start collapsed)', () => {
    for (const name of PRESET_NAMES2) {
      const out = applyPreset2(name);
      for (const id of WIDGET_IDS2) expect(out.hidden[id], `${name}.${id}`).toBe(PRESET_HIDDEN2[name].includes(id));
    }
    expect(applyPreset2('standard').hidden).toEqual({ pane1: false, pane2: false, summary: true, clip: true, saved: true });
  });

  it('returns a copy so callers cannot mutate PRESETS2', () => {
    const out = applyPreset2('chat-big');
    out.rects.pane1.w = 1;
    expect(PRESETS2['chat-big'].pane1.w).toBe(32.5);
  });
});

describe('loadLayout2 / saveLayout2', () => {
  it('falls back to standard when nothing is stored, the JSON is bad, or storage throws', () => {
    expect(loadLayout2(fakeStorage())).toEqual(applyPreset2('standard'));
    expect(loadLayout2(fakeStorage({ [STORAGE_KEY_V2]: '{not json' }))).toEqual(applyPreset2('standard'));
    const throwing: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => {} };
    expect(loadLayout2(throwing)).toEqual(applyPreset2('standard'));
    expect(loadLayout2(null)).toEqual(applyPreset2('standard'));
  });

  it('falls back to standard when a rect is malformed or a widget is missing', () => {
    const bad = { preset: 'custom', rects: { ...PRESETS2.standard, pane1: { x: 'a', y: 0, w: 10, h: 10 } } };
    expect(loadLayout2(fakeStorage({ [STORAGE_KEY_V2]: JSON.stringify(bad) }))).toEqual(applyPreset2('standard'));
    const { clip: _omit, ...rest } = PRESETS2.standard;
    expect(loadLayout2(fakeStorage({ [STORAGE_KEY_V2]: JSON.stringify({ preset: 'standard', rects: rest }) }))).toEqual(applyPreset2('standard'));
  });

  it('round-trips custom rects and hidden flags', () => {
    const storage = fakeStorage();
    const state = setHidden({ ...applyPreset2('standard'), preset: 'custom', rects: { ...PRESETS2.standard, pane1: rect(5, 5, 45, 60) } }, 'summary', true);
    expect(saveLayout2(state, storage)).toBe(true);
    expect(loadLayout2(storage)).toEqual(state);
    expect(loadLayout2(storage).hidden.summary).toBe(true);
  });

  it('marks an unknown preset name as custom and treats a missing hidden map as nothing hidden', () => {
    const stored = { preset: 'weird', rects: PRESETS2['chat-big'] };
    const loaded = loadLayout2(fakeStorage({ [STORAGE_KEY_V2]: JSON.stringify(stored) }));
    expect(loaded.preset).toBe('custom');
    expect(loaded.rects).toEqual(PRESETS2['chat-big']);
    // everything shows except the saved-sessions widget, which starts hidden
    expect(Object.entries(loaded.hidden).filter(([, v]) => v).map(([k]) => k)).toEqual(['saved']);
  });

  it('accepts a layout saved before the saved-sessions widget existed (its rect and hidden flag are filled in)', () => {
    const { saved: _s, ...rects } = PRESETS2.standard;
    const old = { preset: 'custom', rects: { ...rects, summary: rect(30, 10, 30, 30) }, hidden: { summary: false, clip: true } };
    const loaded = loadLayout2(fakeStorage({ [STORAGE_KEY_V2]: JSON.stringify(old) }));
    expect(loaded.rects.summary).toEqual(rect(30, 10, 30, 30));
    expect(loaded.rects.saved).toEqual(PRESETS2.standard.saved);
    expect(loaded.hidden.saved).toBe(true);
    expect(loaded.hidden.clip).toBe(true);
    expect(loaded.hidden.summary).toBe(false);
  });

  it('drops an extra rect such as an old graph rect', () => {
    const stored = { preset: 'custom', rects: { ...PRESETS2.standard, graph: rect(0, 0, 50, 70) } };
    const loaded = loadLayout2(fakeStorage({ [STORAGE_KEY_V2]: JSON.stringify(stored) }));
    expect(Object.keys(loaded.rects).sort()).toEqual([...WIDGET_IDS2].sort());
  });

  it('reports failure instead of throwing when the write is refused', () => {
    const throwing: StorageLike = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(saveLayout2(applyPreset2('standard'), throwing)).toBe(false);
  });
});

describe('hiding and the v1 layout', () => {
  it('setHidden returns a new state, keeps the preset and does not mutate the input', () => {
    const state = applyPreset2('standard');
    const out = setHidden(state, 'pane2', true);
    expect(out.hidden.pane2).toBe(true);
    expect(out.preset).toBe('standard');
    expect(state.hidden.pane2).toBe(false);
    expect(setHidden(out, 'pane2', false).hidden.pane2).toBe(false);
  });

  it('never reads or writes the v1 key, so switching versions keeps both layouts', () => {
    const v1 = JSON.stringify({ preset: 'custom', rects: { marker: 1 } });
    const storage = fakeStorage({ [STORAGE_KEY_V1]: v1 });
    expect(STORAGE_KEY_V2).not.toBe(STORAGE_KEY_V1);
    expect(loadLayout2(storage)).toEqual(applyPreset2('standard'));
    saveLayout2(setHidden(applyPreset2('standard'), 'pane2', true), storage);
    expect(storage.data[STORAGE_KEY_V1]).toBe(v1);
    expect(Object.keys(storage.data).sort()).toEqual([STORAGE_KEY_V1, STORAGE_KEY_V2].sort());
  });
});

describe('coverRightPct', () => {
  it('only counts the floating widgets (summary, clip); panes are canvas nodes now', () => {
    expect(coverRightPct(applyPreset2('standard'))).toBe(0); // summary and clip start hidden
    const s = setHidden(setHidden(applyPreset2('graph-big'), 'summary', false), 'clip', false);
    expect(coverRightPct(s)).toBe(60); // both sit at x=40
  });

  it('ignores hidden widgets and widgets on the left', () => {
    const s = setHidden(applyPreset2('chat-big'), 'summary', false);
    expect(coverRightPct(s)).toBe(0); // summary sits at x=0
    expect(coverRightPct(setHidden(applyPreset2('graph-big'), 'clip', false))).toBe(60);
  });
});
