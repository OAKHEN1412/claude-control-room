// Typed fetch helpers and pure helpers for the setup UI (Settings, Check this PC, update banner).
// Server shapes: server/src/settingsApi.ts, doctorApi.ts, updateApi.ts, config.ts.
// Secret rule: the ElevenLabs key is write-only. No helper here returns, echoes or logs a key value; the
// only key state that exists in this module is 'set' | 'unset'.
import { apiBase } from './useServer';
import type { TKey } from './i18n';

// ---------- types (mirror the server) ----------

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}
export interface DoctorReport {
  ok: boolean;
  checkedAt: number;
  checks: DoctorCheck[];
}

export type KeyState = 'set' | 'unset';
export interface VoiceRow {
  id: string;
  name: string;
}
export interface CrConfig {
  language: 'th' | 'en' | 'auto';
  port: number | null;
  galleryRoots: string[];
  videosDir: string | null;
  extraCwds: string[];
  voices: VoiceRow[];
  update: { check: boolean; channel: 'stable' };
}
export interface EnvOverrides {
  port: boolean;
  galleryRoots: boolean;
  videosDir: boolean;
  extraCwds: boolean;
}
export interface SettingsState {
  config: CrConfig;
  warnings: string[];
  envOverrides: EnvOverrides;
  secrets: { elevenlabs: KeyState };
  dataDir: string;
  file: string;
}

/** Field-by-field save body. Only the fields that changed are sent. */
export interface SettingsPatch {
  language?: CrConfig['language'];
  port?: number | null;
  galleryRoots?: string[];
  videosDir?: string | null;
  extraCwds?: string[];
  voices?: VoiceRow[];
  update?: { check: boolean };
}

export interface BusyCounts {
  running: number;
  waiting: number;
  clips: number;
}
export interface ReleaseInfo {
  version: string;
  tag: string;
  url: string;
  notes: string;
  publishedAt: string;
}
export interface UpdateState {
  current: string;
  latest: ReleaseInfo | null;
  available: boolean;
  checkedAt: number;
  enabled: boolean;
  failed: boolean;
  canUpdate: { ok: boolean; reason?: string };
  busy: BusyCounts;
  scheduled: boolean;
  applying: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------- key state (write-only secret) ----------

/** Maps whatever the server sent to the only two states the UI knows. Anything but 'set' is 'unset'. */
export function keyState(v: unknown): KeyState {
  return v === 'set' ? 'set' : 'unset';
}

export function keyStateKey(s: KeyState): TKey {
  return s === 'set' ? 'set.key.set' : 'set.key.unset';
}

/** Client-side pre-check that matches the server rule (8-200 characters, no whitespace). Returns a boolean only. */
export function isValidKeyInput(value: string): boolean {
  const v = value.trim();
  return v.length >= 8 && v.length <= 200 && !/\s/.test(v);
}

// ---------- busy / update button logic ----------

/** The first busy reason to show, in priority order running > waiting > clips. Null when nothing is busy. */
export function busyReason(busy: BusyCounts): { key: TKey; count: number } | null {
  if (busy.running > 0) return { key: 'upd.busy.running', count: busy.running };
  if (busy.waiting > 0) return { key: 'upd.busy.waiting', count: busy.waiting };
  if (busy.clips > 0) return { key: 'upd.busy.clips', count: busy.clips };
  return null;
}

export function busyTotal(busy: BusyCounts): number {
  return busy.running + busy.waiting + busy.clips;
}

/** Text key explaining why canUpdate is not ok. 'no-marker' is a dev checkout; unknown reasons use the generic key. */
export function canUpdateReasonKey(reason: string | undefined): TKey {
  switch (reason) {
    case 'no-marker':
      return 'upd.reason.noMarker';
    case 'dirty-tree':
      return 'upd.reason.dirtyTree';
    case 'not-git':
      return 'upd.reason.notGit';
    default:
      return 'upd.reason.other';
  }
}

/** "Update now" is disabled while anything is busy, while an update is already running, or when canUpdate is not ok. */
export function updateNowDisabled(u: Pick<UpdateState, 'busy' | 'canUpdate' | 'applying'>): boolean {
  return busyTotal(u.busy) > 0 || !u.canUpdate.ok || u.applying;
}

/** "Update when idle" is disabled when canUpdate is not ok or when an update is already scheduled or running. */
export function updateWhenIdleDisabled(u: Pick<UpdateState, 'canUpdate' | 'scheduled' | 'applying'>): boolean {
  return !u.canUpdate.ok || u.scheduled || u.applying;
}

/** Release notes link: only https URLs are opened. */
export function isHttpsUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------- status colours ----------

export function statusClass(status: string): 'st-ok' | 'st-warn' | 'st-fail' {
  if (status === 'ok') return 'st-ok';
  if (status === 'fail') return 'st-fail';
  return 'st-warn';
}

export function statusKey(status: string): TKey {
  if (status === 'ok') return 'doc.status.ok';
  if (status === 'fail') return 'doc.status.fail';
  return 'doc.status.warn';
}

export const CHECK_IDS = [
  'node',
  'git',
  'claude',
  'claudeLogin',
  'chrome',
  'ffmpeg',
  'ffprobe',
  'hyperframesSkills',
  'lemoPlugin',
  'lemoStyles',
  'elevenKey',
  'dataDir',
] as const;

/**
 * Dictionary key for a doctor check id's title/hint, or null for an unknown id. Built keys are untyped, so the UI
 * passes them to tx(key, undefined, fallback): an unknown id then shows the id itself.
 */
export function checkTitleKey(id: string): string | null {
  return (CHECK_IDS as readonly string[]).includes(id) ? `doc.check.${id}.title` : null;
}

export function checkHintKey(id: string): string | null {
  return (CHECK_IDS as readonly string[]).includes(id) ? `doc.check.${id}.hint` : null;
}

// ---------- settings draft and patch ----------

export interface SettingsDraft {
  language: CrConfig['language'];
  port: number | null;
  galleryRootsText: string;
  videosDir: string;
  extraCwdsText: string;
  voices: VoiceRow[];
  updateCheck: boolean;
}

/** One path per line; blanks dropped, surrounding spaces trimmed. */
export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function joinLines(list: string[]): string {
  return list.join('\n');
}

export function draftFromConfig(c: CrConfig): SettingsDraft {
  return {
    language: c.language,
    port: c.port,
    galleryRootsText: joinLines(c.galleryRoots),
    videosDir: c.videosDir ?? '',
    extraCwdsText: joinLines(c.extraCwds),
    voices: c.voices.map((v) => ({ id: v.id, name: v.name })),
    updateCheck: c.update.check,
  };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameVoices(a: VoiceRow[], b: VoiceRow[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name);
}

/**
 * Builds the PUT body from the saved config and the draft. Only fields that differ are included; an empty object
 * means nothing changed. An empty videosDir is sent as null (clears it), because the server rejects ''.
 */
export function buildSettingsPatch(saved: CrConfig, draft: SettingsDraft): SettingsPatch {
  const patch: SettingsPatch = {};
  if (draft.language !== saved.language) patch.language = draft.language;
  if (draft.port !== saved.port) patch.port = draft.port;
  const roots = parseLines(draft.galleryRootsText);
  if (!sameList(roots, saved.galleryRoots)) patch.galleryRoots = roots;
  const videos = draft.videosDir.trim() === '' ? null : draft.videosDir.trim();
  if (videos !== (saved.videosDir ?? null)) patch.videosDir = videos;
  const extra = parseLines(draft.extraCwdsText);
  if (!sameList(extra, saved.extraCwds)) patch.extraCwds = extra;
  if (!sameVoices(draft.voices, saved.voices)) patch.voices = draft.voices.map((v) => ({ id: v.id, name: v.name }));
  if (draft.updateCheck !== saved.update.check) patch.update = { check: draft.updateCheck };
  return patch;
}

// ---------- local storage flags (try/catch, injectable for tests) ----------

export type FlagStore = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

function defaultStore(): FlagStore {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export const SEEN_KEY = 'cr-setup-seen';
export const DISMISS_KEY = 'cr-update-dismissed';

/** True when the first-run check tab has already been shown on this browser. */
export function hasSeenSetup(store: FlagStore = defaultStore()): boolean {
  try {
    return store?.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markSetupSeen(store: FlagStore = defaultStore()): void {
  try {
    store?.setItem(SEEN_KEY, '1');
  } catch {
    // storage blocked: the tab simply opens again next time
  }
}

export function isDismissed(version: string, store: FlagStore = defaultStore()): boolean {
  try {
    return store?.getItem(DISMISS_KEY) === version;
  } catch {
    return false;
  }
}

export function dismissVersion(version: string, store: FlagStore = defaultStore()): void {
  try {
    store?.setItem(DISMISS_KEY, version);
  } catch {
    // ignored: the banner comes back on reload
  }
}

// ---------- network ----------

type Base = string;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function base(b?: Base): Base {
  return b ?? apiBase();
}

async function call<T>(f: Fetcher, url: string, init?: RequestInit): Promise<Result<{ status: number; body: T }>> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: true, value: { status: res.status, body: body as T } };
}

function errorCode(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return fallback;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function fetchSettings(b?: Base, f: Fetcher = fetch): Promise<Result<SettingsState>> {
  const r = await call<SettingsState>(f, `${base(b)}/api/settings`);
  if (!r.ok) return r;
  if (r.value.status !== 200 || !r.value.body) return { ok: false, error: errorCode(r.value.body, 'HTTP_' + r.value.status) };
  return { ok: true, value: r.value.body };
}

export async function saveSettings(patch: SettingsPatch, b?: Base, f: Fetcher = fetch): Promise<Result<SettingsState>> {
  const r = await call<SettingsState & { ok?: boolean }>(f, `${base(b)}/api/settings`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!r.ok) return r;
  if (r.value.status !== 200 || !r.value.body) return { ok: false, error: errorCode(r.value.body, 'HTTP_' + r.value.status) };
  return { ok: true, value: r.value.body };
}

/** Sends the key once and returns only the resulting key state. The value is never part of the result. */
export async function putSecret(value: string, b?: Base, f: Fetcher = fetch): Promise<Result<KeyState>> {
  const r = await call<{ ok?: boolean; secrets?: { elevenlabs?: unknown }; error?: string }>(f, `${base(b)}/api/settings/secret/elevenlabs`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ value }),
  });
  if (!r.ok) return r;
  if (r.value.status !== 200) return { ok: false, error: errorCode(r.value.body, 'HTTP_' + r.value.status) };
  return { ok: true, value: keyState(r.value.body?.secrets?.elevenlabs) };
}

export async function clearSecret(b?: Base, f: Fetcher = fetch): Promise<Result<KeyState>> {
  const r = await call<{ ok?: boolean; secrets?: { elevenlabs?: unknown }; error?: string }>(f, `${base(b)}/api/settings/secret/elevenlabs`, {
    method: 'DELETE',
  });
  if (!r.ok) return r;
  if (r.value.status !== 200) return { ok: false, error: errorCode(r.value.body, 'HTTP_' + r.value.status) };
  return { ok: true, value: keyState(r.value.body?.secrets?.elevenlabs) };
}

export async function fetchDoctor(b?: Base, f: Fetcher = fetch): Promise<Result<DoctorReport>> {
  return doctorCall(`${base(b)}/api/doctor`, f);
}

export async function refreshDoctor(b?: Base, f: Fetcher = fetch): Promise<Result<DoctorReport>> {
  return doctorCall(`${base(b)}/api/doctor/refresh`, f, { method: 'POST' });
}

async function doctorCall(url: string, f: Fetcher, init?: RequestInit): Promise<Result<DoctorReport>> {
  const r = await call<DoctorReport>(f, url, init);
  if (!r.ok) return r;
  if (r.value.status !== 200 || !r.value.body || !Array.isArray(r.value.body.checks)) {
    return { ok: false, error: errorCode(r.value.body, 'HTTP_' + r.value.status) };
  }
  return { ok: true, value: r.value.body };
}

export async function fetchUpdate(b?: Base, f: Fetcher = fetch): Promise<Result<UpdateState>> {
  const r = await call<UpdateState>(f, `${base(b)}/api/update`);
  if (!r.ok) return r;
  if (r.value.status !== 200 || !r.value.body) return { ok: false, error: errorCode(r.value.body, 'HTTP_' + r.value.status) };
  return { ok: true, value: r.value.body };
}

export async function checkUpdate(b?: Base, f: Fetcher = fetch): Promise<Result<UpdateState>> {
  const r = await call<UpdateState>(f, `${base(b)}/api/update/check`, { method: 'POST' });
  if (!r.ok) return r;
  if (r.value.status !== 200 || !r.value.body) return { ok: false, error: errorCode(r.value.body, 'HTTP_' + r.value.status) };
  return { ok: true, value: r.value.body };
}

/** Starts an update now, or schedules it for when the server is idle. */
export async function applyUpdate(whenIdle: boolean, b?: Base, f: Fetcher = fetch): Promise<Result<{ applying: boolean; scheduled: boolean }>> {
  const r = await call<{ ok?: boolean; applying?: boolean; scheduled?: boolean; error?: string }>(f, `${base(b)}/api/update/apply`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ whenIdle }),
  });
  if (!r.ok) return r;
  if (r.value.status !== 200) return { ok: false, error: errorCode(r.value.body, 'HTTP_' + r.value.status) };
  return { ok: true, value: { applying: r.value.body?.applying === true, scheduled: r.value.body?.scheduled === true } };
}

export async function cancelUpdate(b?: Base, f: Fetcher = fetch): Promise<Result<true>> {
  const r = await call<{ ok?: boolean }>(f, `${base(b)}/api/update/cancel`, { method: 'POST' });
  if (!r.ok) return r;
  if (r.value.status !== 200) return { ok: false, error: errorCode(r.value.body, 'HTTP_' + r.value.status) };
  return { ok: true, value: true };
}

export const UPDATE_POLL_MS = 60_000;
