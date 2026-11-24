// Which main screen to show: v1 (graph widget + five tiled widgets) or v2 (full-screen canvas + floating widgets).
// Saved in localStorage; `?ui=v1` / `?ui=v2` in the URL wins for that page load without being saved.

export type UiVersion = 'v1' | 'v2';
export const UI_VERSION_KEY = 'cr-ui-version';
export const DEFAULT_UI_VERSION: UiVersion = 'v2';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export const isUiVersion = (v: unknown): v is UiVersion => v === 'v1' || v === 'v2';

/** The version named by a URL query string ("?ui=v1"), or null. */
export function versionFromSearch(search: string): UiVersion | null {
  try {
    const v = new URLSearchParams(search).get('ui');
    return isUiVersion(v) ? v : null;
  } catch {
    return null;
  }
}

/** URL override first, then the saved choice, then the default. Never throws. */
export function resolveUiVersion(search: string, storage: StorageLike | null = defaultStorage()): UiVersion {
  const fromUrl = versionFromSearch(search);
  if (fromUrl) return fromUrl;
  try {
    const saved = storage?.getItem(UI_VERSION_KEY);
    if (isUiVersion(saved)) return saved;
  } catch {
    /* blocked storage: use the default */
  }
  return DEFAULT_UI_VERSION;
}

/** Saves the choice. Returns false when storage is unavailable or refuses the write. */
export function saveUiVersion(v: UiVersion, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(UI_VERSION_KEY, v);
    return true;
  } catch {
    return false;
  }
}

/** The query string with `ui` set to `v`, only when it already carries a `ui` param (otherwise unchanged). */
export function syncSearch(search: string, v: UiVersion): string {
  const p = new URLSearchParams(search);
  if (!p.has('ui')) return search;
  p.set('ui', v);
  return `?${p.toString()}`;
}
