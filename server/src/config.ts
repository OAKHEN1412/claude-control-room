// Machine-wide config file (<dataDir>/config.json). Parsing is tolerant (bad fields fall back to defaults with a
// warning), patches are strict. Env vars always beat the file, so a launcher can pin a value without editing it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './cmdlog';

export interface CrConfig {
  language: 'th' | 'en' | 'auto';
  port: number | null;
  galleryRoots: string[];
  videosDir: string | null;
  extraCwds: string[];
  voices: { id: string; name: string }[];
  update: { check: boolean; channel: 'stable' };
}

/** A save patch: `update` may be given field by field. */
export type CrConfigPatch = Partial<Omit<CrConfig, 'update'>> & { update?: Partial<CrConfig['update']> };

export const VOICE_ID_RE = /^[A-Za-z0-9]{8,40}$/;
const LANGUAGES = ['th', 'en', 'auto'];
const CONFIG_KEYS = ['language', 'port', 'galleryRoots', 'videosDir', 'extraCwds', 'voices', 'update'];
const UPDATE_KEYS = ['check', 'channel'];
const MAX_PATH = 500;
const MAX_LIST = 50;
const MAX_VOICE_NAME = 80;
const BOM = 0xfeff;

function makeDefaults(): CrConfig {
  return {
    language: 'auto',
    port: null,
    galleryRoots: [],
    videosDir: null,
    extraCwds: [],
    voices: [],
    update: { check: true, channel: 'stable' },
  };
}

/** Shallow-frozen defaults for reading. Use defaultConfig() when you need a mutable copy. */
export const DEFAULT_CONFIG: Readonly<CrConfig> = Object.freeze(makeDefaults());

export function defaultConfig(): CrConfig {
  return makeDefaults();
}

export function configFile(dir: string = dataDir()): string {
  return path.join(dir, 'config.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
}

function isPathStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_PATH;
}

function isLanguage(v: unknown): v is CrConfig['language'] {
  return typeof v === 'string' && LANGUAGES.includes(v);
}

function parsePathList(raw: unknown, field: string, warnings: string[]): string[] {
  if (!Array.isArray(raw)) {
    warnings.push(`${field}: must be an array of strings; using default`);
    return [];
  }
  const out: string[] = [];
  let bad = 0;
  for (const item of raw) {
    if (isPathStr(item)) out.push(item);
    else bad++;
  }
  if (bad > 0) warnings.push(`${field}: ${bad} invalid entr${bad === 1 ? 'y' : 'ies'} skipped`);
  if (out.length > MAX_LIST) {
    warnings.push(`${field}: more than ${MAX_LIST} entries, extra entries ignored`);
    out.length = MAX_LIST;
  }
  return out;
}

function parseVoices(raw: unknown, warnings: string[]): { id: string; name: string }[] {
  if (!Array.isArray(raw)) {
    warnings.push('voices: must be an array; using default');
    return [];
  }
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let bad = 0;
  let dup = 0;
  let over = 0;
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !VOICE_ID_RE.test(item.id) ||
        typeof item.name !== 'string' || item.name.trim() === '' || item.name.length > MAX_VOICE_NAME) {
      bad++;
      continue;
    }
    if (seen.has(item.id)) {
      dup++;
      continue;
    }
    if (out.length >= MAX_LIST) {
      over++;
      continue;
    }
    seen.add(item.id);
    out.push({ id: item.id, name: item.name });
  }
  if (bad > 0) warnings.push(`voices: ${bad} invalid entr${bad === 1 ? 'y' : 'ies'} skipped`);
  if (dup > 0) warnings.push(`voices: ${dup} duplicate id entr${dup === 1 ? 'y' : 'ies'} dropped`);
  if (over > 0) warnings.push(`voices: more than ${MAX_LIST} entries, extra entries ignored`);
  return out;
}

/** Tolerant parse: never throws. Unknown keys are ignored silently. A leading BOM is stripped. */
export function parseConfig(text: string): { config: CrConfig; warnings: string[] } {
  const config = defaultConfig();
  const warnings: string[] = [];
  let raw: unknown;
  try {
    const s = String(text);
    raw = JSON.parse(s.charCodeAt(0) === BOM ? s.slice(1) : s);
  } catch {
    warnings.push('config.json: invalid JSON, using defaults');
    return { config, warnings };
  }
  if (!isPlainObject(raw)) {
    warnings.push('config.json: top level must be an object, using defaults');
    return { config, warnings };
  }
  if (raw.language !== undefined) {
    if (isLanguage(raw.language)) config.language = raw.language;
    else warnings.push('language: must be "th", "en" or "auto"; using default');
  }
  if (raw.port !== undefined) {
    if (raw.port === null) config.port = null;
    else if (isPort(raw.port)) config.port = raw.port;
    else warnings.push('port: must be an integer 1-65535 or null; using default');
  }
  if (raw.galleryRoots !== undefined) config.galleryRoots = parsePathList(raw.galleryRoots, 'galleryRoots', warnings);
  if (raw.extraCwds !== undefined) config.extraCwds = parsePathList(raw.extraCwds, 'extraCwds', warnings);
  if (raw.videosDir !== undefined) {
    if (raw.videosDir === null) config.videosDir = null;
    else if (isPathStr(raw.videosDir)) config.videosDir = raw.videosDir;
    else warnings.push('videosDir: must be a non-empty path or null; using default');
  }
  if (raw.voices !== undefined) config.voices = parseVoices(raw.voices, warnings);
  if (raw.update !== undefined) {
    if (!isPlainObject(raw.update)) {
      warnings.push('update: must be an object; using defaults');
    } else {
      const u = raw.update;
      if (u.check !== undefined) {
        if (typeof u.check === 'boolean') config.update.check = u.check;
        else warnings.push('update.check: must be true or false; using default');
      }
      if (u.channel !== undefined) {
        if (u.channel === 'stable') config.update.channel = 'stable';
        else warnings.push('update.channel: must be "stable"; using default');
      }
    }
  }
  return { config, warnings };
}

export interface LoadedConfig {
  config: CrConfig;
  warnings: string[];
  file: string;
  exists: boolean;
}

/** Missing file = defaults, no warning. Unreadable or bad file = defaults plus a warning. Never throws. */
export function loadConfig(dir: string = dataDir()): LoadedConfig {
  const file = configFile(dir);
  let exists = false;
  try {
    exists = fs.existsSync(file);
  } catch {
    exists = false;
  }
  if (!exists) return { config: defaultConfig(), warnings: [], file, exists };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { config: defaultConfig(), warnings: ['config.json: unreadable, using defaults'], file, exists };
  }
  const parsed = parseConfig(text);
  return { config: parsed.config, warnings: parsed.warnings, file, exists };
}

type PatchResult = { ok: true; patch: CrConfigPatch } | { ok: false; error: string };

function fail(error: string): PatchResult {
  return { ok: false, error };
}

function validatePathList(raw: unknown, field: string): string | string[] {
  if (!Array.isArray(raw)) return `${field}: must be an array of paths`;
  if (raw.length > MAX_LIST) return `${field}: at most ${MAX_LIST} entries`;
  for (const item of raw) {
    if (!isPathStr(item)) return `${field}: each entry must be a non-empty string of at most ${MAX_PATH} characters`;
  }
  return raw as string[];
}

/** Strict validation of a settings patch. Unknown keys and wrong types are errors, never ignored. */
export function validateConfigPatch(input: unknown): PatchResult {
  if (!isPlainObject(input)) return fail('body must be a JSON object');
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.includes(key)) return fail('unknown key');
  }
  const patch: CrConfigPatch = {};
  if (input.language !== undefined) {
    if (!isLanguage(input.language)) return fail('language: must be "th", "en" or "auto"');
    patch.language = input.language;
  }
  if (input.port !== undefined) {
    if (input.port !== null && !isPort(input.port)) return fail('port: must be an integer 1-65535 or null');
    patch.port = input.port as number | null;
  }
  for (const field of ['galleryRoots', 'extraCwds'] as const) {
    if (input[field] !== undefined) {
      const r = validatePathList(input[field], field);
      if (typeof r === 'string') return fail(r);
      patch[field] = r;
    }
  }
  if (input.videosDir !== undefined) {
    if (input.videosDir !== null && !isPathStr(input.videosDir)) return fail('videosDir: must be a non-empty path or null');
    patch.videosDir = input.videosDir as string | null;
  }
  if (input.voices !== undefined) {
    if (!Array.isArray(input.voices)) return fail('voices: must be an array');
    if (input.voices.length > MAX_LIST) return fail(`voices: at most ${MAX_LIST} entries`);
    const seen = new Set<string>();
    const voices: { id: string; name: string }[] = [];
    for (const v of input.voices) {
      if (!isPlainObject(v) || typeof v.id !== 'string' || !VOICE_ID_RE.test(v.id)) return fail('voices: id must be 8-40 letters or digits');
      if (typeof v.name !== 'string' || v.name.trim() === '' || v.name.length > MAX_VOICE_NAME) return fail(`voices: name must be 1-${MAX_VOICE_NAME} characters`);
      if (seen.has(v.id)) return fail('voices: duplicate id');
      seen.add(v.id);
      voices.push({ id: v.id, name: v.name });
    }
    patch.voices = voices;
  }
  if (input.update !== undefined) {
    if (!isPlainObject(input.update)) return fail('update: must be an object');
    const u: Partial<CrConfig['update']> = {};
    for (const key of Object.keys(input.update)) {
      if (!UPDATE_KEYS.includes(key)) return fail('update: unknown key');
    }
    if (input.update.check !== undefined) {
      if (typeof input.update.check !== 'boolean') return fail('update.check: must be true or false');
      u.check = input.update.check;
    }
    if (input.update.channel !== undefined) {
      if (input.update.channel !== 'stable') return fail('update.channel: must be "stable"');
      u.channel = 'stable';
    }
    patch.update = u;
  }
  return { ok: true, patch };
}

function withoutUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Loads the current file, shallow-merges the patch (update field by field), writes atomically, returns the new config. */
export function saveConfig(patch: CrConfigPatch, dir: string = dataDir()): CrConfig {
  const current = loadConfig(dir).config;
  const { update, ...rest } = patch;
  const merged = {
    ...current,
    ...withoutUndefined(rest),
    update: { ...current.update, ...withoutUndefined(update ?? {}) },
  };
  // Re-parse so the written file is always in the normalised shape.
  const next = parseConfig(JSON.stringify(merged)).config;
  fs.mkdirSync(dir, { recursive: true });
  const file = configFile(dir);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup
    }
    throw e;
  }
  return next;
}

// ---- env-wins helpers -------------------------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

function envSet(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function splitList(v: string | undefined): string[] {
  if (!envSet(v)) return [];
  return v.split(path.delimiter).map((s) => s.trim()).filter((s) => s !== '');
}

/** CR_PORT, then PORT, then config.port, then the fallback. An env value that is not a valid port is skipped. */
export function effectivePort(env: Env, config: CrConfig, fallback: number): number {
  for (const key of ['CR_PORT', 'PORT']) {
    const raw = env[key];
    if (envSet(raw) && /^\d+$/.test(raw.trim())) {
      const n = Number(raw.trim());
      if (isPort(n)) return n;
    }
  }
  return config.port ?? fallback;
}

export function effectiveGalleryRoots(env: Env, config: CrConfig): string[] {
  const fromEnv = splitList(env.CR_GALLERY_ROOTS);
  if (fromEnv.length > 0) return fromEnv;
  if (config.galleryRoots.length > 0) return [...config.galleryRoots];
  return [path.join(os.homedir(), 'videos')];
}

export function effectiveVideosDir(env: Env, config: CrConfig): string {
  if (envSet(env.CR_VIDEOS_DIR)) return env.CR_VIDEOS_DIR.trim();
  return config.videosDir ?? path.join(os.homedir(), 'videos');
}

/** Union of CR_EXTRA_CWDS (env first) and config.extraCwds, de-duplicated in order. */
export function effectiveExtraCwds(env: Env, config: CrConfig): string[] {
  return [...new Set([...splitList(env.CR_EXTRA_CWDS), ...config.extraCwds])];
}

/** Which env overrides are currently set (non-empty). The values themselves are never returned. */
export function envOverrides(env: Env): { port: boolean; galleryRoots: boolean; videosDir: boolean; extraCwds: boolean } {
  return {
    port: envSet(env.CR_PORT) || envSet(env.PORT),
    galleryRoots: envSet(env.CR_GALLERY_ROOTS),
    videosDir: envSet(env.CR_VIDEOS_DIR),
    extraCwds: envSet(env.CR_EXTRA_CWDS),
  };
}
