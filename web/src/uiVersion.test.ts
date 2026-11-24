import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_VERSION,
  UI_VERSION_KEY,
  resolveUiVersion,
  saveUiVersion,
  syncSearch,
  versionFromSearch,
  type StorageLike,
} from './uiVersion';

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => void (data[k] = v) };
}

describe('resolveUiVersion', () => {
  it('defaults to v2 with nothing saved', () => {
    expect(DEFAULT_UI_VERSION).toBe('v2');
    expect(resolveUiVersion('', fakeStorage())).toBe('v2');
  });

  it('reads the saved choice', () => {
    expect(resolveUiVersion('', fakeStorage({ [UI_VERSION_KEY]: 'v1' }))).toBe('v1');
    expect(resolveUiVersion('', fakeStorage({ [UI_VERSION_KEY]: 'v2' }))).toBe('v2');
  });

  it('lets ?ui= override the saved choice', () => {
    const s = fakeStorage({ [UI_VERSION_KEY]: 'v2' });
    expect(resolveUiVersion('?ui=v1', s)).toBe('v1');
    expect(resolveUiVersion('?x=1&ui=v2', fakeStorage({ [UI_VERSION_KEY]: 'v1' }))).toBe('v2');
  });

  it('does not save the URL override', () => {
    const s = fakeStorage();
    resolveUiVersion('?ui=v1', s);
    expect(s.data).toEqual({});
  });

  it('ignores junk in the URL and in storage', () => {
    expect(resolveUiVersion('?ui=v3', fakeStorage({ [UI_VERSION_KEY]: 'v1' }))).toBe('v1');
    expect(resolveUiVersion('', fakeStorage({ [UI_VERSION_KEY]: 'banana' }))).toBe('v2');
    expect(versionFromSearch('?ui=')).toBeNull();
  });

  it('falls back to the default when storage throws or is missing', () => {
    const boom: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(resolveUiVersion('', boom)).toBe('v2');
    expect(resolveUiVersion('', null)).toBe('v2');
    expect(resolveUiVersion('?ui=v1', boom)).toBe('v1');
  });
});

describe('saveUiVersion', () => {
  it('writes the choice so the next load reads it back', () => {
    const s = fakeStorage();
    expect(saveUiVersion('v1', s)).toBe(true);
    expect(s.data[UI_VERSION_KEY]).toBe('v1');
    expect(resolveUiVersion('', s)).toBe('v1');
    saveUiVersion('v2', s);
    expect(resolveUiVersion('', s)).toBe('v2');
  });

  it('reports failure instead of throwing', () => {
    const boom: StorageLike = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(saveUiVersion('v1', boom)).toBe(false);
    expect(saveUiVersion('v1', null)).toBe(false);
  });

  it('does not touch the layout keys of either version', () => {
    const s = fakeStorage({ 'cr-layout-v1': 'A', 'cr-layout-v2': 'B' });
    saveUiVersion('v1', s);
    expect(s.data['cr-layout-v1']).toBe('A');
    expect(s.data['cr-layout-v2']).toBe('B');
  });
});

describe('syncSearch', () => {
  it('rewrites an existing ui param so a reload keeps the switch', () => {
    expect(syncSearch('?ui=v1', 'v2')).toBe('?ui=v2');
    expect(syncSearch('?a=1&ui=v1', 'v2')).toBe('?a=1&ui=v2');
  });

  it('leaves a URL without a ui param alone', () => {
    expect(syncSearch('', 'v1')).toBe('');
    expect(syncSearch('?demo=1', 'v1')).toBe('?demo=1');
  });
});
