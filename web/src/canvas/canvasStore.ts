// Remembered node positions (localStorage), keyed like canvasLayout's StoredPositions.
import { keySession, type StoredPositions } from './canvasLayout';

export const POSITIONS_KEY = 'cr-canvas-v1';

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

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function loadPositions(storage: StorageLike | null = defaultStorage()): StoredPositions {
  try {
    const raw = storage?.getItem(POSITIONS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: StoredPositions = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const p = v as { x?: unknown; y?: unknown } | null;
      if (p && finite(p.x) && finite(p.y)) out[k] = { x: p.x, y: p.y };
    }
    return out;
  } catch {
    return {};
  }
}

export function savePositions(pos: StoredPositions, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(POSITIONS_KEY, JSON.stringify(pos));
    return true;
  } catch {
    return false;
  }
}

/** Drops positions of sessions that no longer exist. Returns the same object when nothing changed. */
export function prunePositions(pos: StoredPositions, liveSessionIds: ReadonlySet<string>): StoredPositions {
  let changed = false;
  const out: StoredPositions = {};
  for (const [k, v] of Object.entries(pos)) {
    const sid = keySession(k);
    if (sid === null || liveSessionIds.has(sid)) out[k] = v;
    else changed = true;
  }
  return changed ? out : pos;
}
