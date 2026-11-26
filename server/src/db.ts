// SQLite store for the worklog (node:sqlite, no dependency). Default file: ~/.claude-control-room/control-room.db.
// node:sqlite is loaded with createRequire so vitest/vite does not try to resolve it as a package.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AccountUsage } from '../../shared/accounts';
import type { ClipJob, ClipOutroPhrase, ClipPreset, ClipQueueItem, ClipSettings, ClipStartInput, MachineShell, WorklogCard } from '../../shared/protocol';
import { dataDir } from './cmdlog';

type Db = import('node:sqlite').DatabaseSync;
const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite') as typeof import('node:sqlite');

export function defaultDbFile(): string {
  return path.join(dataDir(), 'control-room.db');
}

export interface FailureRow {
  id: string; // tool_use id (or entry uuid for an API error)
  sessionId: string;
  ts: number;
  tool: string;
  text: string;
}

export interface CardRow extends WorklogCard {
  activityAt: number; // session activity the card was built from; a newer activity makes the card stale
  summarizedAt: number; // last time a summary call was attempted for this card (0 = never)
}

export interface SavedRow {
  sessionId: string;
  cwd: string;
  title: string;
  name: string;
  model: string | null;
  effort: string | null;
  source: 'terminal' | 'web' | 'clip';
  firstSeen: number;
  lastActivity: number;
  hidden: boolean;
}

export interface MachineRow {
  id: string;
  name: string;
  host: string;
  user: string;
  keyPath: string;
  shell: MachineShell;
  notes: string;
  agent?: boolean; // keep a tunnel to the Control Room agent on this machine (remote sessions)
  created: number;
}

export interface RunnerJobRow {
  sessionId: string;
  cwd: string;
  model: string | null; // value for claude --model, as the child confirmed it
  effort: string | null;
  title: string;
  permissionMode: string;
  updatedAt: number;
}

export type CallKind = 'summary' | 'ask';

/** One Claude account profile. Never holds a token: only the fingerprint of it. */
export interface AccountRow {
  id: string;
  name: string;
  color: string;
  letter: string;
  note: string;
  fingerprint: string | null;
  createdAt: number;
  tokenAt: number | null;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastUsage: AccountUsage | null;
  hidden: boolean;
}

/** Columns an accounts update may touch. The key is the AccountRow field, the value the SQL column. */
const ACCOUNT_COLUMNS: Record<keyof Omit<AccountRow, 'id' | 'createdAt'>, string> = {
  name: 'name',
  color: 'color',
  letter: 'letter',
  note: 'note',
  fingerprint: 'fingerprint',
  tokenAt: 'token_at',
  lastCheckAt: 'last_check_at',
  lastCheckOk: 'last_check_ok',
  lastUsage: 'last_usage',
  hidden: 'hidden',
};

/** last_usage is JSON text. Anything that is not an object with a numeric updatedAt reads as null. */
function parseAccountUsage(v: unknown): AccountUsage | null {
  if (typeof v !== 'string' || v === '') return null;
  try {
    const parsed: unknown = JSON.parse(v);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.updatedAt !== 'number') return null;
    return parsed as AccountUsage;
  } catch {
    return null;
  }
}

export class WorklogDb {
  private readonly db: Db;

  constructor(file: string = defaultDbFile()) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS failures (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        tool TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS failures_session ON failures(session_id, ts);
      CREATE TABLE IF NOT EXISTS cards (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        finished_at INTEGER NOT NULL,
        activity_at INTEGER NOT NULL,
        result TEXT,
        bullets TEXT NOT NULL,
        failure_count INTEGER NOT NULL,
        state TEXT NOT NULL,
        summarized_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_calls (
        n INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT,
        ok INTEGER NOT NULL,
        ms INTEGER NOT NULL,
        cost_usd REAL
      );
      CREATE INDEX IF NOT EXISTS calls_ts ON model_calls(ts);
      CREATE TABLE IF NOT EXISTS voices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        builtin INTEGER NOT NULL,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clip_jobs (
        session_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        slug TEXT NOT NULL,
        cwd TEXT NOT NULL,
        style_id TEXT NOT NULL,
        style_name TEXT NOT NULL,
        settings TEXT NOT NULL,
        voice_id TEXT,
        script_model TEXT NOT NULL,
        builder_model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        stage INTEGER NOT NULL,
        render_requested INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clip_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        settings TEXT NOT NULL,
        style_id TEXT NOT NULL,
        suggested INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clip_outros (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clip_queue (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        style_name TEXT NOT NULL,
        input TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS clip_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS saved_sessions (
        session_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        model TEXT,
        effort TEXT,
        source TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        hidden_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS saved_activity ON saved_sessions(last_activity);
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        user TEXT NOT NULL,
        key_path TEXT NOT NULL,
        shell TEXT NOT NULL,
        notes TEXT NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runner_jobs (
        session_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        title TEXT NOT NULL DEFAULT '',
        permission_mode TEXT NOT NULL DEFAULT 'default',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        letter TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        fingerprint TEXT,
        created_at INTEGER NOT NULL,
        token_at INTEGER,
        last_check_at INTEGER,
        last_check_ok INTEGER,
        last_usage TEXT,
        hidden INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS account_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_accounts (
        session_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // additive migration: machines.agent (remote agent toggle)
    const cols = this.db.prepare('PRAGMA table_info(machines)').all();
    if (!cols.some((c) => c.name === 'agent')) this.db.exec('ALTER TABLE machines ADD COLUMN agent INTEGER NOT NULL DEFAULT 0');
  }

  // ---- live Runner jobs, remembered so they can be resumed after a server restart ----

  upsertRunnerJob(j: RunnerJobRow): void {
    this.db
      .prepare(
        `INSERT INTO runner_jobs (session_id, cwd, model, effort, title, permission_mode, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, model = excluded.model, effort = excluded.effort,
           title = excluded.title, permission_mode = excluded.permission_mode, updated_at = excluded.updated_at`,
      )
      .run(j.sessionId, j.cwd, j.model, j.effort, j.title, j.permissionMode, j.updatedAt);
  }

  deleteRunnerJob(sessionId: string): boolean {
    return Number(this.db.prepare('DELETE FROM runner_jobs WHERE session_id = ?').run(sessionId).changes) > 0;
  }

  /** Newest first. */
  listRunnerJobs(): RunnerJobRow[] {
    return this.db
      .prepare('SELECT session_id, cwd, model, effort, title, permission_mode, updated_at FROM runner_jobs ORDER BY updated_at DESC, session_id')
      .all()
      .map((r) => ({
        sessionId: String(r.session_id),
        cwd: String(r.cwd),
        model: r.model === null || r.model === undefined ? null : String(r.model),
        effort: r.effort === null || r.effort === undefined ? null : String(r.effort),
        title: String(r.title),
        permissionMode: String(r.permission_mode),
        updatedAt: Number(r.updated_at),
      }));
  }

  close(): void {
    this.db.close();
  }

  /** Returns true when the failure is new (deduped by tool_use id). */
  insertFailure(f: FailureRow): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO failures (id, session_id, ts, tool, text) VALUES (?, ?, ?, ?, ?)')
      .run(f.id, f.sessionId, f.ts, f.tool, f.text);
    return Number(r.changes) > 0;
  }

  failuresFor(sessionId: string): FailureRow[] {
    const rows = this.db.prepare('SELECT id, session_id, ts, tool, text FROM failures WHERE session_id = ? ORDER BY ts, id').all(sessionId);
    return rows.map((r) => ({
      id: String(r.id),
      sessionId: String(r.session_id),
      ts: Number(r.ts),
      tool: String(r.tool),
      text: String(r.text),
    }));
  }

  failureCount(sessionId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM failures WHERE session_id = ?').get(sessionId);
    return Number(r?.n ?? 0);
  }

  upsertCard(c: CardRow): void {
    this.db
      .prepare(
        `INSERT INTO cards (session_id, title, cwd, finished_at, activity_at, result, bullets, failure_count, state, summarized_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, cwd = excluded.cwd, finished_at = excluded.finished_at,
           activity_at = excluded.activity_at, result = excluded.result, bullets = excluded.bullets,
           failure_count = excluded.failure_count, state = excluded.state, summarized_at = excluded.summarized_at,
           updated_at = excluded.updated_at`,
      )
      .run(c.sessionId, c.title, c.cwd, c.finishedAt, c.activityAt, c.result, JSON.stringify(c.bullets), c.failureCount, c.state, c.summarizedAt, c.updatedAt);
  }

  private toCard(r: Record<string, unknown>): CardRow {
    let bullets: string[] = [];
    try {
      const v = JSON.parse(String(r.bullets));
      if (Array.isArray(v)) bullets = v.filter((x): x is string => typeof x === 'string');
    } catch {
      // keep empty
    }
    return {
      sessionId: String(r.session_id),
      title: String(r.title),
      cwd: String(r.cwd),
      finishedAt: Number(r.finished_at),
      activityAt: Number(r.activity_at),
      result: r.result === null || r.result === undefined ? null : String(r.result),
      bullets,
      failureCount: Number(r.failure_count),
      state: r.state === 'haiku' || r.state === 'rule' ? r.state : 'queued',
      summarizedAt: Number(r.summarized_at),
      updatedAt: Number(r.updated_at),
    };
  }

  getCard(sessionId: string): CardRow | null {
    const r = this.db.prepare('SELECT * FROM cards WHERE session_id = ?').get(sessionId);
    return r ? this.toCard(r) : null;
  }

  /** Cards finished at or after `since`, newest first. */
  cardsSince(since: number): CardRow[] {
    return this.db
      .prepare('SELECT * FROM cards WHERE finished_at >= ? ORDER BY finished_at DESC')
      .all(since)
      .map((r) => this.toCard(r));
  }

  logCall(c: { ts: number; kind: CallKind; sessionId?: string; ok: boolean; ms: number; costUsd?: number | null }): void {
    this.db
      .prepare('INSERT INTO model_calls (ts, kind, session_id, ok, ms, cost_usd) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.ts, c.kind, c.sessionId ?? null, c.ok ? 1 : 0, c.ms, c.costUsd ?? null);
  }

  /** Model calls since `since`, optionally of one kind. */
  callsSince(since: number, kind?: CallKind): { ts: number; kind: CallKind; sessionId: string | null; ok: boolean }[] {
    const rows = kind
      ? this.db.prepare('SELECT ts, kind, session_id, ok FROM model_calls WHERE ts >= ? AND kind = ? ORDER BY ts').all(since, kind)
      : this.db.prepare('SELECT ts, kind, session_id, ok FROM model_calls WHERE ts >= ? ORDER BY ts').all(since);
    return rows.map((r) => ({
      ts: Number(r.ts),
      kind: r.kind === 'ask' ? 'ask' : 'summary',
      sessionId: r.session_id === null ? null : String(r.session_id),
      ok: Number(r.ok) === 1,
    }));
  }

  // ---- stage 5: voice IDs ----

  /** Inserts the seed voices that are missing; existing rows (and their names) are kept. */
  seedVoices(seed: readonly { id: string; name: string }[], now: number): void {
    const st = this.db.prepare('INSERT OR IGNORE INTO voices (id, name, builtin, added_at) VALUES (?, ?, 1, ?)');
    seed.forEach((v, i) => st.run(v.id, v.name, now + i));
  }

  listVoices(): { id: string; name: string; builtin: boolean }[] {
    return this.db
      .prepare('SELECT id, name, builtin FROM voices ORDER BY builtin DESC, added_at, id')
      .all()
      .map((r) => ({ id: String(r.id), name: String(r.name), builtin: Number(r.builtin) === 1 }));
  }

  addVoice(id: string, name: string): void {
    this.db.prepare('INSERT OR IGNORE INTO voices (id, name, builtin, added_at) VALUES (?, ?, 0, ?)').run(id, name, Date.now());
  }

  /** Removes a user-added voice. Seed voices stay. Returns true when a row was removed. */
  removeVoice(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM voices WHERE id = ? AND builtin = 0').run(id).changes) > 0;
  }

  // ---- stage 5: clip jobs ----

  insertClip(c: ClipJob): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO clip_jobs (session_id, topic, slug, cwd, style_id, style_name, settings, voice_id, script_model, builder_model, created_at, stage, render_requested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.sessionId, c.topic, c.slug, c.cwd, c.styleId, c.styleName, JSON.stringify(c.settings), c.voiceId, c.scriptModel, c.builderModel, c.createdAt, c.stage, c.renderRequested ? 1 : 0);
  }

  private toClip(r: Record<string, unknown>): ClipJob {
    let settings: ClipSettings;
    try {
      settings = JSON.parse(String(r.settings)) as ClipSettings;
    } catch {
      settings = { length: '60s', ratio: '16:9', lang: 'th', voice: true, music: true, cast: [] };
    }
    const stage = Number(r.stage);
    return {
      sessionId: String(r.session_id),
      topic: String(r.topic),
      slug: String(r.slug),
      cwd: String(r.cwd),
      styleId: String(r.style_id),
      styleName: String(r.style_name),
      settings,
      voiceId: r.voice_id === null || r.voice_id === undefined ? null : String(r.voice_id),
      scriptModel: String(r.script_model),
      builderModel: String(r.builder_model),
      createdAt: Number(r.created_at),
      stage,
      ready: stage >= 4,
      renderRequested: Number(r.render_requested) === 1,
    };
  }

  /** Clip jobs, newest first. */
  listClips(): ClipJob[] {
    return this.db
      .prepare('SELECT * FROM clip_jobs ORDER BY created_at DESC')
      .all()
      .map((r) => this.toClip(r));
  }

  getClip(sessionId: string): ClipJob | null {
    const r = this.db.prepare('SELECT * FROM clip_jobs WHERE session_id = ?').get(sessionId);
    return r ? this.toClip(r) : null;
  }

  setClipStage(sessionId: string, stage: number): void {
    this.db.prepare('UPDATE clip_jobs SET stage = ? WHERE session_id = ?').run(stage, sessionId);
  }

  setClipRenderRequested(sessionId: string): void {
    this.db.prepare('UPDATE clip_jobs SET render_requested = 1 WHERE session_id = ?').run(sessionId);
  }
  // ---- clip presets and the waiting queue ----

  private toPreset(r: Record<string, unknown>): ClipPreset | null {
    try {
      return {
        id: String(r.id),
        name: String(r.name),
        settings: JSON.parse(String(r.settings)) as ClipSettings,
        styleId: String(r.style_id),
        suggested: Number(r.suggested) === 1,
        createdAt: Number(r.created_at),
      };
    } catch {
      return null;
    }
  }

  /** Presets in the order they were made. */
  listPresets(): ClipPreset[] {
    return this.db
      .prepare('SELECT * FROM clip_presets ORDER BY created_at ASC, rowid ASC')
      .all()
      .map((r) => this.toPreset(r))
      .filter((p): p is ClipPreset => p !== null);
  }

  getPreset(id: string): ClipPreset | null {
    const r = this.db.prepare('SELECT * FROM clip_presets WHERE id = ?').get(id);
    return r ? this.toPreset(r) : null;
  }

  /** Insert, or replace everything but the creation time of an existing preset. A saved preset is never "suggested". */
  savePreset(p: Omit<ClipPreset, 'suggested'> & { suggested?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO clip_presets (id, name, settings, style_id, suggested, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, settings = excluded.settings, style_id = excluded.style_id, suggested = excluded.suggested`,
      )
      .run(p.id, p.name, JSON.stringify(p.settings), p.styleId, p.suggested ? 1 : 0, p.createdAt);
  }

  deletePreset(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM clip_presets WHERE id = ?').run(id).changes) > 0;
  }

  /**
   * First run only (remembered in clip_meta, so deleting every preset later does not bring them back):
   * up to `max` distinct (settings, style) combinations of past clips, most used first, as editable "suggested" presets.
   */
  seedPresetsOnce(now: number, makeName: (settings: ClipSettings, styleName: string) => string, makeId: () => string, max = 3): ClipPreset[] {
    if (this.db.prepare("SELECT 1 FROM clip_meta WHERE key = 'presets_seeded'").get()) return [];
    this.db.prepare("INSERT INTO clip_meta (key, value) VALUES ('presets_seeded', ?)").run(String(now));
    if (this.listPresets().length > 0) return [];
    const groups = new Map<string, { settings: ClipSettings; styleId: string; styleName: string; n: number }>();
    for (const j of this.listClips()) {
      const key = JSON.stringify([j.settings.length, j.settings.ratio, j.settings.lang, j.settings.voice, j.settings.music, [...j.settings.cast].sort(), j.styleId]);
      const g = groups.get(key);
      if (g) g.n++;
      else groups.set(key, { settings: j.settings, styleId: j.styleId, styleName: j.styleName, n: 1 });
    }
    const top = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, max); // stable: ties keep newest first
    const out: ClipPreset[] = [];
    top.forEach((g, i) => {
      const p: ClipPreset = { id: makeId(), name: makeName(g.settings, g.styleName), settings: g.settings, styleId: g.styleId, suggested: true, createdAt: now + i };
      this.savePreset(p);
      out.push(p);
    });
    return out;
  }

  // ---- saved ending phrases ----

  listOutros(): ClipOutroPhrase[] {
    return this.db
      .prepare('SELECT * FROM clip_outros ORDER BY created_at ASC, rowid ASC')
      .all()
      .map((r) => ({ id: String(r.id), name: String(r.name), text: String(r.text), createdAt: Number(r.created_at) }));
  }

  saveOutro(o: ClipOutroPhrase): void {
    this.db
      .prepare(
        `INSERT INTO clip_outros (id, name, text, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, text = excluded.text`,
      )
      .run(o.id, o.name, o.text, o.createdAt);
  }

  deleteOutro(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM clip_outros WHERE id = ?').run(id).changes) > 0;
  }

  enqueueClip(id: string, input: ClipStartInput, styleName: string, createdAt: number): void {
    this.db
      .prepare('INSERT INTO clip_queue (id, topic, style_name, input, created_at, error) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(id, input.topic.trim(), styleName, JSON.stringify(input), createdAt);
  }

  /** Waiting clips, oldest first, with the full start request. */
  listQueued(): { item: ClipQueueItem; input: ClipStartInput }[] {
    const out: { item: ClipQueueItem; input: ClipStartInput }[] = [];
    for (const r of this.db.prepare('SELECT * FROM clip_queue ORDER BY created_at ASC, rowid ASC').all()) {
      try {
        const input = JSON.parse(String(r.input)) as ClipStartInput;
        out.push({
          input,
          item: {
            id: String(r.id),
            topic: String(r.topic),
            settings: input.settings,
            styleId: input.styleId,
            styleName: String(r.style_name),
            createdAt: Number(r.created_at),
            ...(r.error ? { error: String(r.error) } : {}),
          },
        });
      } catch {
        this.db.prepare('DELETE FROM clip_queue WHERE id = ?').run(String(r.id)); // unreadable row: drop it
      }
    }
    return out;
  }

  removeQueued(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM clip_queue WHERE id = ?').run(id).changes) > 0;
  }

  setQueuedError(id: string, error: string): void {
    this.db.prepare('UPDATE clip_queue SET error = ? WHERE id = ?').run(error, id);
  }

  // ---- saved sessions ----

  /** Insert or update one remembered session. `hidden` is never overwritten unless `unhide` is set. */
  upsertSaved(r: SavedRow, unhide = false): void {
    this.db
      .prepare(
        `INSERT INTO saved_sessions (session_id, cwd, title, name, model, effort, source, first_seen, last_activity, hidden, hidden_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
         ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, title = excluded.title, name = excluded.name,
           model = excluded.model, effort = excluded.effort, source = excluded.source,
           last_activity = MAX(saved_sessions.last_activity, excluded.last_activity),
           first_seen = MIN(saved_sessions.first_seen, excluded.first_seen),
           hidden = CASE WHEN ? = 1 THEN 0 ELSE saved_sessions.hidden END,
           hidden_at = CASE WHEN ? = 1 THEN NULL ELSE saved_sessions.hidden_at END`,
      )
      .run(r.sessionId, r.cwd, r.title, r.name, r.model, r.effort, r.source, r.firstSeen, r.lastActivity, unhide ? 1 : 0, unhide ? 1 : 0);
  }

  private toSaved(r: Record<string, unknown>): SavedRow {
    const src = r.source === 'web' || r.source === 'clip' ? r.source : 'terminal';
    return {
      sessionId: String(r.session_id),
      cwd: String(r.cwd),
      title: String(r.title),
      name: String(r.name ?? ''),
      model: r.model === null || r.model === undefined ? null : String(r.model),
      effort: r.effort === null || r.effort === undefined ? null : String(r.effort),
      source: src,
      firstSeen: Number(r.first_seen),
      lastActivity: Number(r.last_activity),
      hidden: Number(r.hidden) === 1,
    };
  }

  getSaved(sessionId: string): SavedRow | null {
    const r = this.db.prepare('SELECT * FROM saved_sessions WHERE session_id = ?').get(sessionId);
    return r ? this.toSaved(r) : null;
  }

  /** Newest activity first. */
  listSaved(limit: number): SavedRow[] {
    return this.db
      .prepare('SELECT * FROM saved_sessions ORDER BY last_activity DESC, session_id LIMIT ?')
      .all(limit)
      .map((r) => this.toSaved(r));
  }

  /** Flips the hidden flag only. Returns false when the id is unknown. */
  setSavedHidden(sessionId: string, hidden: boolean, at: number): boolean {
    const r = this.db
      .prepare('UPDATE saved_sessions SET hidden = ?, hidden_at = ? WHERE session_id = ?')
      .run(hidden ? 1 : 0, hidden ? at : null, sessionId);
    return Number(r.changes) > 0;
  }

  hiddenSavedIds(): string[] {
    return this.db.prepare('SELECT session_id FROM saved_sessions WHERE hidden = 1').all().map((r) => String(r.session_id));
  }

  // ---- machines ----

  private toMachine(r: Record<string, unknown>): MachineRow {
    return {
      id: String(r.id),
      name: String(r.name),
      host: String(r.host),
      user: String(r.user),
      keyPath: String(r.key_path),
      shell: r.shell === 'powershell' || r.shell === 'bash' ? r.shell : 'cmd',
      notes: String(r.notes),
      agent: Number(r.agent ?? 0) === 1,
      created: Number(r.created),
    };
  }

  listMachines(): MachineRow[] {
    return this.db
      .prepare('SELECT * FROM machines ORDER BY created, id')
      .all()
      .map((r) => this.toMachine(r));
  }

  getMachine(id: string): MachineRow | null {
    const r = this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id);
    return r ? this.toMachine(r) : null;
  }

  /** PRAGMA user_version >= 1 once the default machines were seeded, so a user who deletes them all is not re-seeded. */
  machinesSeeded(): boolean {
    return Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0) >= 1;
  }

  markMachinesSeeded(): void {
    this.db.exec('PRAGMA user_version = 1');
  }

  countMachines(): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM machines').get()?.n ?? 0);
  }

  insertMachine(m: MachineRow): void {
    this.db
      .prepare('INSERT INTO machines (id, name, host, user, key_path, shell, notes, agent, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, m.name, m.host, m.user, m.keyPath, m.shell, m.notes, m.agent ? 1 : 0, m.created);
  }

  updateMachine(m: Omit<MachineRow, 'created'>): boolean {
    const r = this.db
      .prepare('UPDATE machines SET name = ?, host = ?, user = ?, key_path = ?, shell = ?, notes = ?, agent = ? WHERE id = ?')
      .run(m.name, m.host, m.user, m.keyPath, m.shell, m.notes, m.agent ? 1 : 0, m.id);
    return Number(r.changes) > 0;
  }

  deleteMachine(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM machines WHERE id = ?').run(id).changes) > 0;
  }

  // ---- accounts (Claude profiles). The token itself is never stored here ----

  private toAccount(r: Record<string, unknown>): AccountRow {
    return {
      id: String(r.id),
      name: String(r.name),
      color: String(r.color),
      letter: String(r.letter),
      note: String(r.note ?? ''),
      fingerprint: r.fingerprint === null || r.fingerprint === undefined ? null : String(r.fingerprint),
      createdAt: Number(r.created_at),
      tokenAt: r.token_at === null || r.token_at === undefined ? null : Number(r.token_at),
      lastCheckAt: r.last_check_at === null || r.last_check_at === undefined ? null : Number(r.last_check_at),
      lastCheckOk: r.last_check_ok === null || r.last_check_ok === undefined ? null : Number(r.last_check_ok) === 1,
      lastUsage: parseAccountUsage(r.last_usage),
      hidden: Number(r.hidden) === 1,
    };
  }

  /** Oldest profile first. */
  listAccounts(): AccountRow[] {
    return this.db
      .prepare('SELECT * FROM accounts ORDER BY created_at, id')
      .all()
      .map((r) => this.toAccount(r));
  }

  getAccount(id: string): AccountRow | null {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return r ? this.toAccount(r) : null;
  }

  insertAccount(row: AccountRow): void {
    this.db
      .prepare(
        `INSERT INTO accounts (id, name, color, letter, note, fingerprint, created_at, token_at, last_check_at, last_check_ok, last_usage, hidden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.color,
        row.letter,
        row.note,
        row.fingerprint,
        row.createdAt,
        row.tokenAt,
        row.lastCheckAt,
        row.lastCheckOk === null ? null : row.lastCheckOk ? 1 : 0,
        row.lastUsage === null ? null : JSON.stringify(row.lastUsage),
        row.hidden ? 1 : 0,
      );
  }

  /** Partial update. Only the keys present in the patch are written; returns false when the id is unknown. */
  updateAccount(id: string, patch: Partial<Omit<AccountRow, 'id' | 'createdAt'>>): boolean {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const key of Object.keys(ACCOUNT_COLUMNS) as (keyof typeof ACCOUNT_COLUMNS)[]) {
      if (!Object.prototype.hasOwnProperty.call(patch, key) || patch[key] === undefined) continue;
      const v = patch[key];
      let sqlValue: string | number | null;
      if (v === null) sqlValue = null;
      else if (key === 'lastCheckOk' || key === 'hidden') sqlValue = v ? 1 : 0;
      else if (key === 'lastUsage') sqlValue = JSON.stringify(v);
      else sqlValue = v as string | number;
      sets.push(`${ACCOUNT_COLUMNS[key]} = ?`);
      values.push(sqlValue);
    }
    if (sets.length === 0) return this.getAccount(id) !== null;
    values.push(id);
    const r = this.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return Number(r.changes) > 0;
  }

  deleteAccount(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes) > 0;
  }

  getAccountSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM account_settings WHERE key = ?').get(key);
    return r ? String(r.value) : null;
  }

  setAccountSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO account_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getSessionAccount(sessionId: string): string | null {
    const r = this.db.prepare('SELECT account_id FROM session_accounts WHERE session_id = ?').get(sessionId);
    return r ? String(r.account_id) : null;
  }

  setSessionAccount(sessionId: string, accountId: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO session_accounts (session_id, account_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET account_id = excluded.account_id, updated_at = excluded.updated_at`,
      )
      .run(sessionId, accountId, at);
  }

  /** Deletes the session rows last updated before `olderThanMs` (an epoch-ms cutoff). Returns how many were removed. */
  pruneSessionAccounts(olderThanMs: number): number {
    return Number(this.db.prepare('DELETE FROM session_accounts WHERE updated_at < ?').run(olderThanMs).changes);
  }
}
