// Usage meters for the top bar. Sources:
//  1. ~/.claude/.handoff-state/<session>.trigger.json, written by the user's status line script (terminal sessions):
//     context %, tokens, model, 5-hour and 7-day quota with reset times. Polled by mtime.
//  2. The stream of a web/Runner job (`claude -p`, no status line): `rate_limit_event` gives the account quota,
//     the last assistant message's usage gives the context (estimated), `result.modelUsage` the window size.
// The freshest account quota wins across all sources; per session the newest entry wins.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type SessionUsage,
  type UsageQuota,
  type UsageSnapshot,
  deriveContext,
  freshest,
  mergeSessions,
  parseRateLimitEvent,
  parseTrigger,
} from '../../shared/usage';

export const TRIGGER_SUFFIX = '.trigger.json';
const MAX_SESSIONS = 40;

export function defaultStateDir(): string {
  return path.join(os.homedir(), '.claude', '.handoff-state');
}

export interface UsageOptions {
  dir?: string;
  now?: () => number;
  pollMs?: number;
  maxAgeMs?: number; // trigger files older than this are ignored (default 6 h)
}

interface FileEntry {
  mtimeMs: number;
  parsed: ReturnType<typeof parseTrigger>;
}

export class UsageService extends EventEmitter {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly maxAgeMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly files = new Map<string, FileEntry>();
  private readonly stream = new Map<string, SessionUsage>(); // Runner sessions, estimated context
  private readonly windows = new Map<string, number>(); // session -> context window size seen in a result event
  private streamFive: UsageQuota | null = null;
  private streamSeven: UsageQuota | null = null;
  private last = JSON.stringify({ fiveHour: null, sevenDay: null, sessions: [] });

  constructor(opts: UsageOptions = {}) {
    super();
    this.dir = opts.dir ?? defaultStateDir();
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 5000;
    this.maxAgeMs = opts.maxAgeMs ?? 6 * 3600_000;
  }

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Scan the state dir (only files whose mtime moved are read) and emit 'change' when the snapshot differs. */
  refresh(): void {
    this.scan();
    this.publish();
  }

  /** A stream-json event of a Runner job. Cheap: ignores everything but the three event kinds. */
  ingest(sessionId: string, ev: unknown): void {
    if (!ev || typeof ev !== 'object') return;
    const e = ev as Record<string, unknown>;
    const at = this.now();
    if (e.type === 'rate_limit_event') {
      const q = parseRateLimitEvent(e, sessionId, at);
      this.streamFive = freshest(this.streamFive, q.fiveHour);
      this.streamSeven = freshest(this.streamSeven, q.sevenDay);
    } else if (e.type === 'result') {
      const mu = e.modelUsage;
      if (mu && typeof mu === 'object') {
        for (const v of Object.values(mu as Record<string, unknown>)) {
          const w = v && typeof v === 'object' ? (v as Record<string, unknown>).contextWindow : null;
          if (typeof w === 'number' && w > 0) this.windows.set(sessionId, w);
        }
      }
    } else if (e.type === 'assistant' && e.parent_tool_use_id == null) {
      const msg = e.message && typeof e.message === 'object' ? (e.message as Record<string, unknown>) : {};
      if (msg.model === '<synthetic>') return;
      const model = typeof msg.model === 'string' ? msg.model : null;
      const d = deriveContext(sessionId, model, msg.usage, at, this.windows.get(sessionId));
      if (d) this.stream.set(sessionId, d);
    } else {
      return;
    }
    this.publish();
  }

  snapshot(): UsageSnapshot {
    let five: UsageQuota | null = this.streamFive;
    let seven: UsageQuota | null = this.streamSeven;
    const sessions: SessionUsage[] = [...this.stream.values()];
    for (const f of this.files.values()) {
      if (!f.parsed) continue;
      five = freshest(five, f.parsed.fiveHour);
      seven = freshest(seven, f.parsed.sevenDay);
      sessions.push(f.parsed.session);
    }
    return { fiveHour: five, sevenDay: seven, sessions: mergeSessions(sessions).slice(0, MAX_SESSIONS) };
  }

  private scan(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(TRIGGER_SUFFIX));
    } catch {
      this.files.clear();
      return;
    }
    const seen = new Set<string>();
    const cutoff = this.now() - this.maxAgeMs;
    for (const name of names) {
      const full = path.join(this.dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) continue;
      seen.add(name);
      if (this.files.get(name)?.mtimeMs === mtimeMs) continue;
      let parsed: ReturnType<typeof parseTrigger> = null;
      try {
        parsed = parseTrigger(JSON.parse(fs.readFileSync(full, 'utf8')), mtimeMs, name.slice(0, -TRIGGER_SUFFIX.length));
      } catch {
        // half-written or not JSON: try again at the next mtime change
      }
      this.files.set(name, { mtimeMs, parsed });
    }
    for (const name of [...this.files.keys()]) if (!seen.has(name)) this.files.delete(name);
  }

  private publish(): void {
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (key === this.last) return;
    this.last = key;
    this.emit('change', snap);
  }
}
