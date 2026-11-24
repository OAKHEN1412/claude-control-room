// Live, read-only view of every Claude Code session on this machine.
// Reads <claude>/sessions/<pid>.json and the transcripts under <claude>/projects.
// Never writes, and never opens *.key files (only /^\d+\.json$/ names are considered).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentInfo, SessionInfo, Status, TimelineEvent } from '../../shared/protocol';
import { summarizerDir } from './cmdlog';
import { claudeDir, projectsDir as projectsDirOf, sessionsDir as sessionsDirOf } from './paths';
import { createState, derive, ingestLine, SUBAGENT_TIMELINE_CAP, TIMELINE_CAP, type TranscriptState } from './parser';
import type { WorklogSource } from './worklog';

const SESSION_FILE_RE = /^\d+\.json$/;
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SUBAGENT_FILE_RE = /^agent-(.+)\.jsonl$/;
const GONE_KEEP_MS = 60_000;
const DEBOUNCE_MS = 150;
const LARGE_FILE_BYTES = 20 * 1024 * 1024;
// A transcript larger than LARGE_FILE_BYTES on its first read is only read from its last
// 4 MB. The line cut by that start is dropped, so older history is not shown.
const FIRST_READ_TAIL_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface WatcherOptions {
  claudeDir?: string;
  pollMs?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  /** A session this returns true for is never dropped as ended (e.g. its child is alive under the Runner). */
  keepAlive?: (sessionId: string) => boolean;
  ignoreCwds?: string[]; // sessions started in these folders are not shown (the summary helper's own scratch folder)
}

function normCwd(p: string): string {
  return path.resolve(p).toLowerCase();
}

/**
 * Scratch folders of the summary helper that are never jobs: this instance's own (CR_DATA_DIR) and the main
 * instance's (~/.claude-control-room), so a second instance with another data dir does not show the main one's helper runs.
 */
export function defaultIgnoreCwds(): string[] {
  return [summarizerDir(), path.join(os.homedir(), '.claude-control-room', 'summarizer')];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads bytes [start, end) of a file. Returns fewer bytes if the file shrank meanwhile. */
function readRange(file: string, start: number, end: number): Buffer {
  const len = end - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

export interface TailSink {
  reset(): void;
  line(text: string): void;
}

/**
 * Incremental reader for one append-only file. Works on bytes: it splits on 0x0A before
 * decoding UTF-8, so multibyte characters are never cut. A trailing partial line is kept
 * until its newline arrives. Truncation (size < offset) resets the sink and re-reads from 0.
 */
export class Tail {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private skipFirst = false;
  mtimeMs = 0;

  constructor(
    readonly file: string,
    private readonly sink: TailSink,
  ) {}

  /** Reads new bytes. Returns true when a line was delivered or the sink was reset. */
  poll(): boolean {
    let size: number;
    try {
      const st = fs.statSync(this.file);
      size = st.size;
      this.mtimeMs = st.mtimeMs;
    } catch {
      return false; // gone or not there yet: keep state
    }
    let touched = false;
    if (size < this.offset) {
      this.reset();
      touched = true;
    }
    if (size <= this.offset) return touched;

    const start = this.offset === 0 && size > LARGE_FILE_BYTES ? size - FIRST_READ_TAIL_BYTES : this.offset;
    if (start > this.offset) this.skipFirst = true;

    let chunk: Buffer;
    try {
      chunk = readRange(this.file, start, size);
    } catch {
      return touched;
    }
    this.offset = start + chunk.length;

    const buf = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    const lastNl = buf.lastIndexOf(NEWLINE);
    if (lastNl < 0) {
      this.pending = Buffer.from(buf);
      return touched;
    }
    this.pending = Buffer.from(buf.subarray(lastNl + 1));
    return this.deliver(buf.subarray(0, lastNl)) || touched;
  }

  /** body holds only complete lines, without the newline that ends the last one. */
  private deliver(body: Buffer): boolean {
    let delivered = false;
    let from = 0;
    for (;;) {
      const nl = body.indexOf(NEWLINE, from);
      const end = nl < 0 ? body.length : nl;
      if (this.skipFirst) {
        this.skipFirst = false; // first piece of a mid-file start is a fragment
      } else {
        const text = body.toString('utf8', from, end).replace(/\r$/, '');
        if (text.trim() !== '') {
          try {
            this.sink.line(text);
          } catch {
            // the sink must not break tailing
          }
          delivered = true;
        }
      }
      if (nl < 0) break;
      from = nl + 1;
    }
    return delivered;
  }

  private reset(): void {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.skipFirst = false;
    this.sink.reset();
  }
}

/** A transcript file tailed into a parser state. */
export class TranscriptReader implements TailSink {
  state: TranscriptState;
  readonly tail: Tail;
  private readonly timelineCap: number;

  constructor(file: string, timelineCap?: number) {
    this.timelineCap = timelineCap ?? TIMELINE_CAP;
    this.state = createState(this.timelineCap);
    this.tail = new Tail(file, this);
  }

  reset(): void {
    this.state = createState(this.timelineCap);
  }

  line(text: string): void {
    ingestLine(this.state, text);
  }

  poll(): boolean {
    return this.tail.poll();
  }
}

interface SessionJson {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  kind: string;
  startedAt: number;
  updatedAt: number | null;
  liveStatus: string; // Claude's own status in sessions/<pid>.json: busy | idle | waiting
}

function parseSessionJson(raw: unknown): SessionJson | null {
  if (!isRecord(raw)) return null;
  const { pid, sessionId } = raw;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== 'string' || !SAFE_ID_RE.test(sessionId)) return null;
  return {
    pid,
    sessionId,
    cwd: str(raw.cwd),
    name: str(raw.name),
    kind: str(raw.kind),
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : null,
    liveStatus: str(raw.status),
  };
}

interface AgentMeta {
  description: string;
  model: string | null;
  effort: string | null;
  finished: boolean;
}

function readMeta(file: string): AgentMeta | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // missing, or still being written
  }
  if (!isRecord(raw)) return null;
  return {
    description: str(raw.description),
    model: nullableStr(raw.model),
    effort: nullableStr(raw.effort),
    finished: raw.finished === true,
  };
}

interface SubEntry {
  metaFile: string;
  reader: TranscriptReader;
  meta: AgentMeta | null;
}

interface SessionEntry {
  json: SessionJson | null; // last valid content of sessions/<file>
  goneSince: number | null; // set when the json file disappears
  deadSince: number | null; // set when the json file is still there but its process is not alive
  transcript: string | null;
  main: TranscriptReader | null;
  subs: Map<string, SubEntry>;
  lastJson: string | null; // serialized SessionInfo last emitted
  info: SessionInfo | null;
  endSeqSeen: number | null; // endTurnSeq already reported (null until the first read of the transcript)
}

function newEntry(): SessionEntry {
  return { json: null, goneSince: null, deadSince: null, transcript: null, main: null, subs: new Map(), lastJson: null, info: null, endSeqSeen: null };
}

/** A finished turn of a watched (terminal) session, from its transcript. */
export interface WatchedTurnEnd {
  sessionId: string;
  text: string; // full final answer, raw (the relay strips secrets)
  ts: number; // timestamp of the transcript entry
  isError: boolean;
  interrupted: boolean;
}

export class Watcher extends EventEmitter {
  private readonly sessionsDir: string;
  private readonly projectsDir: string;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly ignore: Set<string>;
  private readonly keepAlive: (sessionId: string) => boolean;
  // stale registry files of ended processes that were already dropped (file name -> "pid:sessionId")
  private readonly dropped = new Map<string, string>();
  // keyed by sessions/<file name>
  private readonly entries = new Map<string, SessionEntry>();
  private running = false;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private sessWatch: fs.FSWatcher | null = null;
  private projWatch: fs.FSWatcher | null = null;

  constructor(opts: WatcherOptions = {}) {
    super();
    const root = opts.claudeDir ?? claudeDir();
    this.sessionsDir = sessionsDirOf(root);
    this.projectsDir = projectsDirOf(root);
    this.pollMs = opts.pollMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.keepAlive = opts.keepAlive ?? (() => false);
    this.ignore = new Set((opts.ignoreCwds ?? defaultIgnoreCwds()).map(normCwd));
  }

  /** Emits 'session' (SessionInfo) when a session is added or changes, and 'removed' (sessionId). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
    this.sessWatch?.close();
    this.projWatch?.close();
    this.sessWatch = null;
    this.projWatch = null;
    this.entries.clear();
  }

  snapshot(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const e of this.entries.values()) if (e.info) out.push(e.info);
    return out.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /**
   * Drops a session now, without the GONE_KEEP_MS wait (the user closed its Runner job). Emits 'removed' once.
   * Its registry file is tombstoned in `dropped`, so a file that still lingers is not shown again.
   */
  forget(sessionId: string): void {
    let shown = false;
    for (const [name, entry] of [...this.entries]) {
      if (!entry.json || entry.json.sessionId !== sessionId) continue;
      this.dropped.set(name, `${entry.json.pid}:${entry.json.sessionId}`);
      this.entries.delete(name);
      if (entry.lastJson !== null) shown = true;
    }
    if (shown) this.safeEmit('removed', sessionId);
  }

  /** Per-session material for the worklog: failures (main + subagent transcripts), last prompts, last text. */
  worklogSources(): WorklogSource[] {
    const out: WorklogSource[] = [];
    for (const e of this.entries.values()) {
      if (!e.info || !e.main) continue;
      const st = e.main.state;
      const failures = [...st.failures];
      for (const sub of e.subs.values()) failures.push(...sub.reader.state.failures);
      out.push({ info: e.info, failures, prompts: [...st.prompts], lastText: st.lastTextFull, turns: st.assistantTurns });
    }
    return out;
  }

  private poll(): void {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      this.ensureWatchers();
      const now = this.now();
      this.scanSessions(now);
      for (const [name, entry] of [...this.entries]) {
        try {
          this.refreshEntry(name, entry, now);
        } catch (e) {
          console.error(`[watcher] ${name}: ${errMsg(e)}`);
        }
      }
    } catch (e) {
      console.error(`[watcher] poll failed: ${errMsg(e)}`);
    } finally {
      this.polling = false;
    }
  }

  /** fs.watch only triggers a poll; the polling loop stays the source of truth. */
  private schedule(): void {
    if (!this.running || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.poll();
    }, DEBOUNCE_MS);
  }

  private ensureWatchers(): void {
    if (!this.sessWatch && fs.existsSync(this.sessionsDir)) {
      this.sessWatch = this.watchDir(this.sessionsDir, false);
    }
    if (!this.projWatch && fs.existsSync(this.projectsDir)) {
      this.projWatch = this.watchDir(this.projectsDir, true);
    }
  }

  private watchDir(dir: string, recursive: boolean): fs.FSWatcher | null {
    try {
      const w = fs.watch(dir, { recursive }, () => this.schedule());
      w.on('error', () => {
        try {
          w.close();
        } catch {
          // already closed
        }
        if (this.sessWatch === w) this.sessWatch = null;
        if (this.projWatch === w) this.projWatch = null;
      });
      return w;
    } catch {
      return null; // polling alone still works
    }
  }

  private scanSessions(now: number): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.sessionsDir);
    } catch {
      // sessions dir not there yet
    }
    const seen = new Set<string>();
    for (const name of names) {
      if (!SESSION_FILE_RE.test(name)) continue;
      let parsed: SessionJson | null = null;
      try {
        parsed = parseSessionJson(JSON.parse(fs.readFileSync(path.join(this.sessionsDir, name), 'utf8')));
      } catch {
        parsed = null; // half-written or bad JSON: skip this round
      }
      if (!parsed) {
        if (this.entries.has(name)) seen.add(name); // keep the last valid content
        continue;
      }
      if (this.ignore.has(normCwd(parsed.cwd))) continue; // our own `claude -p` helper is not a job
      const stamp = `${parsed.pid}:${parsed.sessionId}`;
      if (this.dropped.get(name) === stamp) continue; // stale file of an ended process, already shown and dropped
      this.dropped.delete(name);
      seen.add(name);
      let entry = this.entries.get(name);
      if (entry?.json && entry.json.sessionId !== parsed.sessionId) {
        this.dropEntry(name, entry); // the same file name now holds another session
        entry = undefined;
      }
      if (!entry) {
        entry = newEntry();
        this.entries.set(name, entry);
      }
      entry.json = parsed;
      entry.goneSince = null;
    }
    for (const name of [...this.dropped.keys()]) if (!names.includes(name)) this.dropped.delete(name);
    for (const [name, entry] of this.entries) {
      if (!seen.has(name) && entry.goneSince === null) entry.goneSince = now;
      // A process killed from outside leaves its registry file behind: time how long it has been dead.
      if (entry.json) {
        const alive = this.isPidAlive(entry.json.pid) || this.keepAlive(entry.json.sessionId);
        if (alive) entry.deadSince = null;
        else if (entry.deadSince === null) entry.deadSince = now;
      }
    }
    this.dedupeBySession();
  }

  /**
   * One entry per sessionId. A resumed session gets a new <pid>.json while the old file lingers (or the old
   * entry is still in its grace period): keep the live entry, drop the rest without telling browsers the
   * session is gone.
   */
  private dedupeBySession(): void {
    const best = new Map<string, [string, SessionEntry]>();
    const rank = (e: SessionEntry): number[] => [e.goneSince === null ? 1 : 0, e.deadSince === null ? 1 : 0, e.json?.startedAt ?? 0, e.json?.pid ?? 0];
    const better = (a: SessionEntry, b: SessionEntry): boolean => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
      return false;
    };
    for (const [name, entry] of [...this.entries]) {
      const id = entry.json?.sessionId;
      if (!id) continue;
      const cur = best.get(id);
      if (!cur) {
        best.set(id, [name, entry]);
      } else if (better(entry, cur[1])) {
        this.entries.delete(cur[0]);
        best.set(id, [name, entry]);
      } else {
        this.entries.delete(name);
      }
    }
  }

  private dropEntry(name: string, entry: SessionEntry): void {
    this.entries.delete(name);
    if (entry.lastJson !== null && entry.json) {
      const id = entry.json.sessionId;
      // another file may already hold this session (resumed under a new pid): it is not gone
      for (const e of this.entries.values()) if (e.json?.sessionId === id) return;
      this.safeEmit('removed', id);
    }
  }

  private refreshEntry(name: string, entry: SessionEntry, now: number): void {
    if (entry.goneSince !== null && now - entry.goneSince >= GONE_KEEP_MS) {
      this.dropEntry(name, entry);
      return;
    }
    if (entry.deadSince !== null && entry.json && now - entry.deadSince >= GONE_KEEP_MS) {
      // file still there, process dead (killed from outside): leave the graph like an ended session does
      this.dropped.set(name, `${entry.json.pid}:${entry.json.sessionId}`);
      this.dropEntry(name, entry);
      return;
    }
    const json = entry.json;
    if (!json) return;
    let info: SessionInfo;
    try {
      info = this.buildInfo(entry, json, now);
    } catch (e) {
      info = unreadableInfo(json, errMsg(e));
    }
    this.publish(entry, info);
  }

  private buildInfo(entry: SessionEntry, json: SessionJson, now: number): SessionInfo {
    const gone = entry.goneSince !== null;
    const alive = this.isPidAlive(json.pid);

    if (!entry.transcript) entry.transcript = this.findTranscript(json.sessionId);
    if (entry.transcript && !entry.main) entry.main = new TranscriptReader(entry.transcript);

    let subagents: AgentInfo[] = [];
    if (entry.transcript) {
      try {
        entry.main?.poll();
      } catch {
        // a read error keeps the last good state
      }
      this.checkTurnEnd(entry, json.sessionId);
      this.syncSubagents(entry, json.sessionId, entry.transcript);
      subagents = this.buildSubagents(entry, now);
    }

    const d = derive(entry.main?.state ?? createState(), { now, processAlive: alive, liveWaiting: json.liveStatus === 'waiting' });
    const dead = gone || !alive;
    let status: Status = d.status;
    // Claude's own session json is authoritative for a permission prompt / question: a live session
    // that says "waiting" is waiting even when the transcript heuristics saw nothing pending.
    if (!dead && status !== 'unreadable' && json.liveStatus === 'waiting') status = 'waiting';
    if (!dead && status === 'idle' && json.liveStatus === 'busy') status = 'running'; // Claude says it is mid-turn
    if (status !== 'unreadable' && dead) status = 'done';
    const reason = d.unreadable ?? (status === 'unreadable' ? 'unreadable' : undefined);

    return {
      sessionId: json.sessionId,
      pid: json.pid,
      name: json.name,
      cwd: json.cwd,
      kind: json.kind,
      title: d.title,
      model: d.model,
      effort: d.effort,
      status,
      thought: d.thought,
      startedAt: json.startedAt,
      lastActivity: d.lastActivity || json.updatedAt || 0,
      timeline: d.timeline,
      subagents,
      ...(d.waitItems.length > 0 && !dead ? { waitItems: d.waitItems } : {}),
      ...(d.limit && !dead ? { limit: d.limit } : {}),
      ...(reason !== undefined ? { unreadable: reason } : {}),
    };
  }

  /** Emits 'turn_end' when the transcript got a new end_turn answer since the last look (history is never replayed). */
  private checkTurnEnd(entry: SessionEntry, sessionId: string): void {
    const st = entry.main?.state;
    if (!st) return;
    if (entry.endSeqSeen === null || st.endTurnSeq < entry.endSeqSeen) {
      entry.endSeqSeen = st.endTurnSeq; // first look (existing history) or the file was reset
      return;
    }
    if (st.endTurnSeq === entry.endSeqSeen) return;
    entry.endSeqSeen = st.endTurnSeq;
    const last = st.lastEndTurn;
    if (!last) return;
    try {
      this.emit('turn_end', { sessionId, text: last.text, ts: last.ts, isError: false, interrupted: false } satisfies WatchedTurnEnd);
    } catch (e) {
      console.error(`[watcher] listener for turn_end threw: ${errMsg(e)}`);
    }
  }

  private findTranscript(sessionId: string): string | null {
    if (!SAFE_ID_RE.test(sessionId)) return null;
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(this.projectsDir, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  private syncSubagents(entry: SessionEntry, sessionId: string, transcript: string): void {
    const dir = path.join(path.dirname(transcript), sessionId, 'subagents');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    const present = new Set<string>();
    for (const name of names) {
      const m = SUBAGENT_FILE_RE.exec(name);
      if (!m) continue;
      const id = m[1];
      present.add(id);
      let sub = entry.subs.get(id);
      if (!sub) {
        sub = {
          metaFile: path.join(dir, `agent-${id}.meta.json`),
          reader: new TranscriptReader(path.join(dir, name), SUBAGENT_TIMELINE_CAP),
          meta: null,
        };
        entry.subs.set(id, sub);
      }
      try {
        sub.reader.poll();
      } catch {
        // keep the last good state
      }
      // Meta may arrive after the jsonl, and `finished` flips later: re-read until finished.
      if (!sub.meta || !sub.meta.finished) sub.meta = readMeta(sub.metaFile) ?? sub.meta;
    }
    for (const id of [...entry.subs.keys()]) {
      if (!present.has(id)) entry.subs.delete(id);
    }
  }

  private buildSubagents(entry: SessionEntry, now: number): AgentInfo[] {
    const out: AgentInfo[] = [];
    for (const [id, sub] of entry.subs) out.push(subagentView(id, sub, now).agent);
    return out.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /**
   * Timeline of one subagent of a shown session: up to SUBAGENT_TIMELINE_CAP events, oldest first, from the
   * same in-memory reader the session's `subagents` list uses. Null for an unknown session or agent.
   * Never touches the disk: ids are only looked up in `entries` and `subs`.
   */
  agentTimeline(sessionId: string, agentId: string): { agent: AgentInfo; timeline: TimelineEvent[] } | null {
    for (const entry of this.entries.values()) {
      if (!entry.info || !entry.json || entry.json.sessionId !== sessionId) continue;
      const sub = entry.subs.get(agentId);
      if (!sub) return null;
      return subagentView(agentId, sub, this.now());
    }
    return null;
  }

  private publish(entry: SessionEntry, info: SessionInfo): void {
    entry.info = info;
    const serialized = JSON.stringify(info);
    if (serialized !== entry.lastJson) {
      entry.lastJson = serialized;
      this.safeEmit('session', info);
    }
  }

  private safeEmit(event: 'session', payload: SessionInfo): void;
  private safeEmit(event: 'removed', payload: string): void;
  private safeEmit(event: 'session' | 'removed', payload: SessionInfo | string): void {
    try {
      this.emit(event, payload);
    } catch (e) {
      console.error(`[watcher] listener for ${event} threw: ${errMsg(e)}`);
    }
  }
}

/** AgentInfo (as the session's `subagents` list shows it) plus the reader's timeline, from one derive(). */
function subagentView(id: string, sub: SubEntry, now: number): { agent: AgentInfo; timeline: TimelineEvent[] } {
  const finished = sub.meta?.finished === true;
  try {
    const d = derive(sub.reader.state, { now, processAlive: null, finished });
    return {
      agent: {
        id,
        description: sub.meta?.description ?? '',
        model: d.model ?? sub.meta?.model ?? null,
        effort: d.effort ?? sub.meta?.effort ?? null,
        status: finished && d.status !== 'unreadable' ? 'done' : d.status,
        thought: d.thought,
        finished,
        lastActivity: d.lastActivity || Math.floor(sub.reader.tail.mtimeMs) || 0,
      },
      timeline: d.timeline,
    };
  } catch (e) {
    return {
      agent: {
        id,
        description: sub.meta?.description ?? '',
        model: sub.meta?.model ?? null,
        effort: sub.meta?.effort ?? null,
        status: 'unreadable',
        thought: `unreadable: ${errMsg(e)}`.slice(0, 120),
        finished,
        lastActivity: 0,
      },
      timeline: [],
    };
  }
}

function unreadableInfo(json: SessionJson, reason: string): SessionInfo {
  return {
    sessionId: json.sessionId,
    pid: json.pid,
    name: json.name,
    cwd: json.cwd,
    kind: json.kind,
    title: '',
    model: null,
    effort: null,
    status: 'unreadable',
    thought: '',
    startedAt: json.startedAt,
    lastActivity: json.updatedAt ?? 0,
    timeline: [],
    subagents: [],
    unreadable: reason,
  };
}
