// Saved sessions: every session the Watcher reports is remembered in SQLite (table saved_sessions) so work can be
// reopened another day. Hiding only flips a flag; transcript files are never deleted or moved. Resume reuses the
// Runner's adopt machinery (--resume in the recorded cwd).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EFFORT_LEVELS, type EffortLevel, type PermissionMode, type SavedSession, type SessionInfo } from '../../shared/protocol';
import { dataDir } from './cmdlog';
import type { SavedRow, WorklogDb } from './db';
import { createState, ingestLine, type TranscriptState } from './parser';
import { CommandError } from './runner';

export const SAVED_LIST_MAX = 300;
export const SAVED_WRITE_MIN_MS = 5000;
export const SAVED_NOTIFY_DEBOUNCE_MS = 1000;
export const BACKFILL_DAYS = 30;
export const BACKFILL_CHUNK = 64 * 1024;
const TITLE_MAX = 80;
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9._-]+$/;

function normPath(p: string): string {
  return path.resolve(p).toLowerCase();
}

/** True when `cwd` is `dir` or below it (case-insensitive, as on Windows). */
export function isUnder(cwd: string, dir: string): boolean {
  const rel = path.relative(normPath(dir), normPath(cwd));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Folders whose sessions are never remembered: the server's own data dir (summarizer scratch, clip folders). */
export function defaultIgnoreDirs(): string[] {
  return [...new Set([dataDir(), path.join(os.homedir(), '.claude-control-room')])];
}

function clipTitle(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** Locates <projects>/<dir>/<sessionId>.jsonl (top level of a project folder only). */
export function findTranscript(projectsDir: string, sessionId: string): string | null {
  if (!SAFE_ID_RE.test(sessionId)) return null;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------- backfill ----------

export interface BackfillItem {
  sessionId: string;
  cwd: string;
  title: string;
  model: string | null;
  effort: string | null;
  lastActivity: number;
}

function linesOf(buf: Buffer, dropFirst: boolean, dropLast: boolean): string[] {
  const parts = buf.toString('utf8').split('\n');
  if (dropFirst) parts.shift();
  if (dropLast) parts.pop();
  return parts.filter((l) => l.trim() !== '');
}

function cwdOfLine(line: string): string | null {
  if (!line.includes('"cwd"')) return null;
  try {
    const o = JSON.parse(line) as unknown;
    if (o && typeof o === 'object' && typeof (o as { cwd?: unknown }).cwd === 'string') {
      const c = (o as { cwd: string }).cwd;
      return c.trim() !== '' ? c : null;
    }
  } catch {
    // partial line
  }
  return null;
}

/** Reads only the first and last 64 KB of one transcript. Null when there is no cwd in what was read. */
export function readTranscriptSummary(file: string, sessionId: string, mtimeMs: number): BackfillItem | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const read = (pos: number, len: number): Buffer => {
      const b = Buffer.alloc(len);
      const n = fs.readSync(fd, b, 0, len, pos);
      return b.subarray(0, n);
    };
    let headLines: string[];
    let tailLines: string[] = [];
    if (size <= BACKFILL_CHUNK * 2) {
      headLines = linesOf(read(0, size), false, false);
    } else {
      headLines = linesOf(read(0, BACKFILL_CHUNK), false, true); // the last line of the head is cut
      tailLines = linesOf(read(size - BACKFILL_CHUNK, BACKFILL_CHUNK), true, false); // the first line of the tail is cut
    }
    let cwd: string | null = null;
    for (const l of headLines) {
      cwd = cwdOfLine(l);
      if (cwd) break;
    }
    if (!cwd) {
      for (const l of tailLines) {
        cwd = cwdOfLine(l);
        if (cwd) break;
      }
    }
    if (!cwd) return null;
    const st: TranscriptState = createState();
    for (const l of headLines) ingestLine(st, l);
    for (const l of tailLines) ingestLine(st, l);
    return {
      sessionId,
      cwd,
      title: clipTitle(st.title || st.firstPrompt || '') || '(ไม่มีชื่อ)',
      model: st.model,
      effort: st.effort,
      lastActivity: st.lastActivityTs > 0 ? st.lastActivityTs : Math.round(mtimeMs),
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export interface BackfillOptions {
  db: WorklogDb;
  projectsDir: string;
  now?: number;
  days?: number;
  ignoreDirs?: string[];
  isClip?: (sessionId: string) => boolean;
}

/** One-time scan of <projects>/*\/*.jsonl modified in the last 30 days. Idempotent; never touches `hidden`. */
export function backfillSaved(opts: BackfillOptions): number {
  const now = opts.now ?? Date.now();
  const since = now - (opts.days ?? BACKFILL_DAYS) * 86_400_000;
  const ignore = opts.ignoreDirs ?? defaultIgnoreDirs();
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(opts.projectsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let written = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(opts.projectsDir, d.name);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (!SAFE_ID_RE.test(sessionId)) continue;
      const file = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.mtimeMs < since) continue;
      const existing = opts.db.getSaved(sessionId);
      const item = readTranscriptSummary(file, sessionId, st.mtimeMs);
      if (!item) continue;
      // an existing row is only refreshed when the file moved on since (the watcher keeps live rows fresher)
      if (existing && item.lastActivity <= existing.lastActivity) continue;
      if (ignore.some((ig) => isUnder(item.cwd, ig))) continue;
      opts.db.upsertSaved({
        sessionId,
        cwd: item.cwd,
        title: item.title,
        name: existing?.name ?? '',
        model: item.model ?? existing?.model ?? null,
        effort: item.effort ?? existing?.effort ?? null,
        source: existing?.source ?? (opts.isClip?.(sessionId) ? 'clip' : 'terminal'),
        firstSeen: existing?.firstSeen ?? item.lastActivity,
        lastActivity: item.lastActivity,
        hidden: false,
      });
      written++;
    }
  }
  return written;
}

// ---------- service ----------

export interface SavedRunner {
  has(sessionId: string): boolean;
  isAlive(sessionId: string): boolean;
  adopt(
    req: {
      sessionId: string;
      cwd: string;
      model?: string;
      effort?: EffortLevel;
      rawModel?: string | null;
      permissionMode?: PermissionMode;
      remoteControl?: boolean;
    },
    opts?: { trustedCwd?: boolean },
  ): string;
}

export interface SavedDeps {
  db: WorklogDb;
  runner?: SavedRunner;
  snapshot: () => SessionInfo[];
  pidAlive: (pid: number) => boolean;
  projectsDir: string;
  isClip?: (sessionId: string) => boolean;
  ignoreDirs?: string[];
  now?: () => number;
}

function sigOf(info: SessionInfo): string {
  return [info.title, info.name, info.model ?? '', info.effort ?? '', info.cwd, info.lastActivity].join('\u0001');
}

export class SavedService extends EventEmitter {
  private readonly deps: SavedDeps;
  private readonly now: () => number;
  private readonly ignore: string[];
  private readonly written = new Map<string, { sig: string; at: number }>();
  private readonly pending = new Map<string, SessionInfo>();
  private readonly hidden: Set<string>;
  private flushTimer: NodeJS.Timeout | null = null;
  private notifyTimer: NodeJS.Timeout | null = null;
  private lastSent = '';

  constructor(deps: SavedDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.ignore = deps.ignoreDirs ?? defaultIgnoreDirs();
    this.hidden = new Set(deps.db.hiddenSavedIds());
  }

  private liveSet(): Set<string> {
    const live = new Set<string>();
    for (const s of this.deps.snapshot()) if (this.deps.pidAlive(s.pid)) live.add(s.sessionId);
    return live;
  }

  private sourceOf(sessionId: string, existing: SavedRow | null): 'terminal' | 'web' | 'clip' {
    const cur: 'terminal' | 'web' | 'clip' = this.deps.isClip?.(sessionId) ? 'clip' : this.deps.runner?.has(sessionId) ? 'web' : 'terminal';
    // never downgrade a session that once ran under the web / clip studio
    if (cur === 'terminal' && existing && existing.source !== 'terminal') return existing.source;
    return cur;
  }

  /** Called for every Watcher session event. Writes only when a field changed, at most once per 5 s per session. */
  onSession(info: SessionInfo): void {
    if (!info.cwd || this.ignore.some((d) => isUnder(info.cwd, d))) return;
    const live = this.deps.pidAlive(info.pid) || this.deps.runner?.isAlive(info.sessionId) === true;
    if (live && this.hidden.has(info.sessionId)) {
      // a hidden session that becomes live again shows normally
      this.hidden.delete(info.sessionId);
      this.write(info, true);
      return;
    }
    const w = this.written.get(info.sessionId);
    if (w && w.sig === sigOf(info)) return;
    if (w && this.now() - w.at < SAVED_WRITE_MIN_MS) {
      this.pending.set(info.sessionId, info); // trailing write
      this.armFlush();
      return;
    }
    this.write(info, false);
  }

  private armFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, SAVED_WRITE_MIN_MS);
    this.flushTimer.unref?.();
  }

  /** Writes pending (throttled) sessions whose 5 s window has passed. */
  flush(): void {
    for (const [id, info] of [...this.pending]) {
      const w = this.written.get(id);
      if (w && this.now() - w.at < SAVED_WRITE_MIN_MS) continue;
      this.pending.delete(id);
      this.write(info, false);
    }
    if (this.pending.size > 0) this.armFlush();
  }

  private write(info: SessionInfo, unhide: boolean): void {
    const existing = this.deps.db.getSaved(info.sessionId);
    this.deps.db.upsertSaved(
      {
        sessionId: info.sessionId,
        cwd: info.cwd,
        title: info.title,
        name: info.name,
        model: info.model,
        effort: info.effort,
        source: this.sourceOf(info.sessionId, existing),
        firstSeen: existing?.firstSeen ?? (info.startedAt > 0 ? info.startedAt : this.now()),
        lastActivity: info.lastActivity > 0 ? info.lastActivity : (existing?.lastActivity ?? this.now()),
        hidden: false,
      },
      unhide,
    );
    this.pending.delete(info.sessionId);
    this.written.set(info.sessionId, { sig: sigOf(info), at: this.now() });
    this.touch();
  }

  /** The list for browsers: newest activity first, at most 300, hidden ones included. */
  list(): SavedSession[] {
    const live = this.liveSet();
    return this.deps.db.listSaved(SAVED_LIST_MAX).map((r) => ({
      sessionId: r.sessionId,
      cwd: r.cwd,
      title: r.title,
      model: r.model,
      effort: r.effort,
      source: r.source,
      firstSeen: r.firstSeen,
      lastActivity: r.lastActivity,
      hidden: r.hidden,
      live: live.has(r.sessionId) || this.deps.runner?.isAlive(r.sessionId) === true,
    }));
  }

  /** Only flips `hidden`. Never touches a transcript file. */
  setHidden(sessionId: string, hidden: boolean): void {
    if (!this.deps.db.setSavedHidden(sessionId, hidden, this.now())) throw new CommandError('ไม่พบ session นี้ในรายการที่บันทึก', 'srv.saved.notFound');
    if (hidden) this.hidden.add(sessionId);
    else this.hidden.delete(sessionId);
    this.touch();
  }

  /** Resumes a saved session under the Runner (--resume in the recorded cwd). */
  resume(req: { sessionId: string; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode }): string {
    const runner = this.deps.runner;
    if (!runner) throw new CommandError('runner is not enabled');
    const row = this.deps.db.getSaved(req.sessionId);
    if (!row) throw new CommandError('ไม่พบ session นี้ในรายการที่บันทึก', 'srv.saved.notFound');
    // a Runner child also shows up in the watcher snapshot, so it is checked first
    if (runner.isAlive(req.sessionId)) throw new CommandError('งานนี้เปิดอยู่แล้ว', 'srv.saved.alreadyOpen');
    const term = this.deps.snapshot().find((s) => s.sessionId === req.sessionId);
    if (term && this.deps.pidAlive(term.pid)) throw new CommandError('session นี้ยังเปิดอยู่ใน terminal', 'srv.saved.inTerminal');
    if (!findTranscript(this.deps.projectsDir, req.sessionId)) throw new CommandError('ไม่พบไฟล์ transcript', 'srv.saved.noTranscript');
    let isDir = false;
    try {
      isDir = fs.statSync(row.cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new CommandError('ไม่พบโฟลเดอร์ของงานนี้', 'srv.saved.noFolder');
    const storedEffort = (EFFORT_LEVELS as readonly string[]).includes(row.effort ?? '') ? (row.effort as EffortLevel) : undefined;
    const rawModel = row.model && SAFE_MODEL_RE.test(row.model) ? row.model : null;
    runner.adopt(
      { sessionId: req.sessionId, cwd: row.cwd, model: req.model, effort: req.effort ?? storedEffort, rawModel, permissionMode: req.permissionMode },
      { trustedCwd: true }, // recorded from Claude's own session json / transcript, folder re-checked above
    );
    this.hidden.delete(req.sessionId);
    this.deps.db.setSavedHidden(req.sessionId, false, this.now());
    this.touch();
    return req.sessionId;
  }

  /** Something that can change the list (live flags, rows) happened: tell browsers after a 1 s debounce. */
  touch(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.notifyNow();
    }, SAVED_NOTIFY_DEBOUNCE_MS);
    this.notifyTimer.unref?.();
  }

  /** Emits 'change' when the list differs from the last one sent. */
  notifyNow(): void {
    const list = this.list();
    const json = JSON.stringify(list);
    if (json === this.lastSent) return;
    this.lastSent = json;
    this.emit('change', list);
  }

  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.flushTimer = null;
    this.notifyTimer = null;
  }
}
