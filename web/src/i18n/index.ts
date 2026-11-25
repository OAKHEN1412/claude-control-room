// Tiny home-made i18n: no library. Source of truth for text = th.ts; en.ts must have every key.
import { useSyncExternalStore } from 'react';
import { th } from './th';
import { en } from './en';

export type Lang = 'th' | 'en';
export type Vars = Record<string, string | number>;
export type TKey = keyof typeof th;

const STORAGE_KEY = 'cr.lang';
const dicts: Record<Lang, Record<string, string>> = { th, en };

export function detectLanguage(): Lang {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (saved === 'th' || saved === 'en') return saved;
  } catch { /* storage blocked */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  return /^th/i.test(nav ?? '') ? 'th' : 'en';
}

let current: Lang = detectLanguage();
const listeners = new Set<() => void>();

export function getLanguage(): Lang { return current; }

/** Set the UI language. persist:false is for a server-config value (does not overwrite the user's own choice). */
export function setLanguage(lang: Lang, opts: { persist?: boolean } = {}): void {
  if (lang !== 'th' && lang !== 'en') return;
  if (opts.persist !== false) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  }
  if (lang === current) return;
  current = lang;
  for (const l of [...listeners]) l();
}

/** Apply the language chosen in the server config (th|en|auto). A user's local choice (cr.lang) wins. */
export function applyConfigLanguage(value: string | undefined | null): void {
  let local: string | null = null;
  try { local = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  if (local === 'th' || local === 'en') return;
  if (value === 'th' || value === 'en') setLanguage(value, { persist: false });
}

export function subscribeLanguage(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function fill(s: string, vars?: Vars): string {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Translate by key in the current language. Falls back to th, then the key itself. */
export function t(key: TKey, vars?: Vars): string {
  return fill(dicts[current][key] ?? th[key] ?? key, vars);
}

/** Translate an untyped key (e.g. a server `code`); returns fallback when the key is unknown. */
export function tx(key: string | undefined | null, vars?: Vars, fallback = ''): string {
  if (!key) return fallback;
  const s = dicts[current][key] ?? dicts.th[key];
  return s === undefined ? fallback : fill(s, vars);
}

/** Hook: re-renders on language change; returns t. Call it in every component that shows text. */
export function useT(): typeof t {
  useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  return t;
}

export function useLang(): [Lang, (l: Lang) => void] {
  const lang = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  return [lang, (l) => setLanguage(l)];
}
