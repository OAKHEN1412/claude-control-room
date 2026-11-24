// Folders a web job may start in: cwds of sessions the watcher already knows, plus project roots
// recorded by Claude Code itself (the `projects` keys of ~/.claude.json) that live under the home folder.
// Only the keys of `projects` are read from that file; nothing else in it is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normPath } from './runner';

export interface CwdSources {
  sessionCwds: () => string[];
  claudeJson?: string; // default ~/.claude.json
  home?: string;
  extra?: string[]; // CR_EXTRA_CWDS
}

const TEMP_RE = /[\\/]appdata[\\/]local[\\/]temp([\\/]|$)/i;

function projectRoots(file: string, home: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const projects = (raw as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== 'object') return [];
  const h = normPath(home);
  return Object.keys(projects).filter((p) => {
    const n = normPath(p);
    return n === h || n.startsWith(h + path.sep);
  });
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Deduplicated (case-insensitive on Windows), existing directories, temp folders left out. */
export function knownCwds(src: CwdSources): string[] {
  const home = src.home ?? os.homedir();
  const sessionCwds = src.sessionCwds().filter((c) => typeof c === 'string' && !TEMP_RE.test(c)); // scratch dirs are not projects
  const all = [
    ...sessionCwds,
    ...projectRoots(src.claudeJson ?? path.join(home, '.claude.json'), home),
    ...(src.extra ?? []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of all) {
    if (!c || typeof c !== 'string') continue;
    const key = normPath(c);
    if (seen.has(key) || !isDir(c)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Caches knownCwds for a short time (the claude.json read is the expensive part). */
export function cachedCwds(src: CwdSources, ttlMs = 5000, now: () => number = Date.now): () => string[] {
  let at = 0;
  let value: string[] = [];
  return () => {
    const t = now();
    if (t - at > ttlMs) {
      value = knownCwds(src);
      at = t;
    }
    return value;
  };
}
