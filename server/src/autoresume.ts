// Auto-resume of Runner jobs after a server restart. The live jobs (session id, cwd, model, effort, title, permission
// mode) are kept in SQLite on change; at startup each one is resumed idle with `--resume` (no prompt is sent) and the
// entries that fail are dropped. A job the user closed is forgotten at once, so it never comes back.
import fs from 'node:fs';
import { EFFORT_LEVELS, PERMISSION_MODES, type EffortLevel, type PermissionMode, type RunnerState } from '../../shared/protocol';
import type { RunnerJobRow, WorklogDb } from './db';
import type { Runner } from './runner';

export const AUTORESUME_MAX = 8;
/** A resumed child that exits within this time did not come back: its entry is dropped. */
export const RESUME_FAIL_MS = 30_000;
const SAFE_MODEL_RE = /^[A-Za-z0-9._-]+$/;

export interface AutoResumeOptions {
  db: WorklogDb;
  runner: Runner;
  titleOf?: (sessionId: string) => string;
  max?: number;
  now?: () => number;
  log?: (m: string) => void;
}

/** Permission mode to resume with: the job's own mode, bypassPermissions included (user decision 2026-11-24). Unknown -> default. */
export function resumeMode(m: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(m) ? (m as PermissionMode) : 'default';
}

export class AutoResume {
  private readonly o: AutoResumeOptions;
  private readonly max: number;
  private readonly now: () => number;
  private readonly last = new Map<string, string>(); // session id -> last written row (JSON without updatedAt)
  private readonly restoring = new Map<string, number>(); // session id -> restore time
  private suspended = false;

  constructor(o: AutoResumeOptions) {
    this.o = o;
    this.max = o.max ?? AUTORESUME_MAX;
    this.now = o.now ?? Date.now;
  }

  private log(m: string): void {
    this.o.log?.(`autoresume: ${m}`);
  }

  start(): void {
    this.o.runner.on('change', this.onChange);
    this.o.runner.on('closing', this.forget);
    this.o.runner.on('removed', this.onRemoved);
  }

  /** Server shutdown: children are about to die, which must not look like closed jobs. */
  suspend(): void {
    this.suspended = true;
    this.o.runner.off('change', this.onChange);
    this.o.runner.off('closing', this.forget);
    this.o.runner.off('removed', this.onRemoved);
  }

  /** Drop a job for good (the user closed it). */
  readonly forget = (sessionId: string): void => {
    if (this.suspended) return;
    this.restoring.delete(sessionId);
    this.last.delete(sessionId);
    this.o.db.deleteRunnerJob(sessionId);
  };

  private readonly onRemoved = (sessionId: string): void => {
    if (this.suspended || this.o.runner.isAlive(sessionId)) return;
    this.forget(sessionId);
  };

  private readonly onChange = (s: RunnerState): void => {
    if (this.suspended) return;
    if (!s.alive) {
      const t = this.restoring.get(s.sessionId);
      if (t !== undefined) {
        this.restoring.delete(s.sessionId);
        if (this.now() - t < RESUME_FAIL_MS) {
          this.log(`${s.sessionId} did not come back (${s.error ?? 'exited'}), dropped`);
          this.forget(s.sessionId);
        }
      }
      return;
    }
    const row: Omit<RunnerJobRow, 'updatedAt'> = {
      sessionId: s.sessionId,
      cwd: s.cwd,
      model: s.model,
      effort: s.effort,
      title: (this.o.titleOf?.(s.sessionId) ?? '').slice(0, 200),
      permissionMode: s.permissionMode,
    };
    const json = JSON.stringify(row);
    if (this.last.get(s.sessionId) === json) return;
    const isNew = !this.last.has(s.sessionId);
    this.last.set(s.sessionId, json);
    this.o.db.upsertRunnerJob({ ...row, updatedAt: this.now() });
    if (isNew) this.prune();
  };

  private prune(): void {
    const rows = this.o.db.listRunnerJobs();
    for (const r of rows.slice(this.max)) {
      this.o.db.deleteRunnerJob(r.sessionId);
      this.last.delete(r.sessionId);
    }
  }

  /** Resumes the remembered jobs (newest first, at most `max`), idle. Returns how many were started. */
  restore(): number {
    const rows = this.o.db.listRunnerJobs();
    let n = 0;
    for (const r of rows) {
      if (n >= this.max) {
        this.o.db.deleteRunnerJob(r.sessionId);
        continue;
      }
      try {
        if (this.o.runner.has(r.sessionId)) continue;
        if (!fs.statSync(r.cwd).isDirectory()) throw new Error('cwd is not a folder');
        const effort = (EFFORT_LEVELS as readonly string[]).includes(r.effort ?? '') ? (r.effort as EffortLevel) : undefined;
        const rawModel = r.model && SAFE_MODEL_RE.test(r.model) ? r.model : null;
        this.restoring.set(r.sessionId, this.now());
        // the folder was whitelisted when the job started and is re-checked above: skip the (still empty) whitelist
        this.o.runner.adopt({ sessionId: r.sessionId, cwd: r.cwd, effort, rawModel, permissionMode: resumeMode(r.permissionMode) }, { trustedCwd: true });
        n++;
      } catch (e) {
        this.restoring.delete(r.sessionId);
        this.log(`${r.sessionId} not resumed: ${e instanceof Error ? e.message : String(e)}`);
        this.o.db.deleteRunnerJob(r.sessionId);
      }
    }
    if (n > 0) this.log(`resumed ${n} job(s) idle`);
    return n;
  }
}
