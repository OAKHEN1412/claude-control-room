// "ยึดมาคุม": one-click take-over of a terminal `claude` session. The server closes exactly that session's claude
// process (taskkill /PID <pid> /T /F, pid re-read from <claude>/sessions/<pid>.json, image name checked first) and
// then resumes the session under the Runner (`claude --resume`), in bypassPermissions as the user decided.
// Nothing here reads the sessions/*.key files or writes into the session's named pipe.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode, SessionInfo } from '../../shared/protocol';
import { sessionsDir as defaultSessionsDir } from './paths';
import { CommandError } from './runner';

export const TAKEOVER_QUIET_MS = 15_000; // transcript written more recently than this = not idle
export const TAKEOVER_EXIT_WAIT_MS = 10_000;
export const TAKEOVER_POLL_MS = 200;
export const TAKEOVER_IMAGE = 'claude.exe';
export const TAKEOVER_MODE: PermissionMode = 'bypassPermissions';
export const BUSY_ERROR = 'งานนี้กำลังทำงานอยู่ รอให้ว่างก่อน';

const SESSION_FILE_RE = /^(\d+)\.json$/; // never the <pid>.<hash>.key files

/** The fields of sessions/<pid>.json that matter here. */
export interface SessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: string;
  status: string;
}

/** Argument array of the kill: the process tree of one exact PID, never a name. */
export function buildTaskkillArgs(pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('bad pid');
  return ['/PID', String(pid), '/T', '/F'];
}

export function buildTasklistArgs(pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('bad pid');
  return ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'];
}

/** Image name from one `tasklist /FO CSV /NH` output ("claude.exe","10284",...); null when no such process. */
export function parseTasklistImage(out: string): string | null {
  const m = /^"([^"]+)"\s*,/m.exec(out);
  return m ? m[1] : null;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

export async function defaultImageName(pid: number): Promise<string | null> {
  return parseTasklistImage(await run('tasklist', buildTasklistArgs(pid)));
}

export async function defaultKill(pid: number): Promise<void> {
  await run('taskkill', buildTaskkillArgs(pid));
}

/** Every sessions/<pid>.json that names `sessionId` (valid JSON, numeric pid). Re-read on every call. */
export function findSessionFiles(dir: string, sessionId: string): SessionFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionFile[] = [];
  for (const name of names) {
    const m = SESSION_FILE_RE.exec(name);
    if (!m) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
      if (raw.sessionId !== sessionId || typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) continue;
      if (raw.pid !== Number(m[1])) continue; // the file name is the pid
      out.push({
        pid: raw.pid,
        sessionId,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        kind: typeof raw.kind === 'string' ? raw.kind : '',
        status: typeof raw.status === 'string' ? raw.status : '',
      });
    } catch {
      // half-written: skip
    }
  }
  return out;
}

export interface TakeoverDeps {
  sessionsDir?: string;
  snapshot: () => SessionInfo[];
  /** A job the Runner owns (alive, or recently dead). */
  isRunnerJob: (sessionId: string) => boolean;
  isClip: (sessionId: string) => boolean;
  pidAlive: (pid: number) => boolean;
  imageName?: (pid: number) => Promise<string | null>;
  kill?: (pid: number) => Promise<void>;
  /** Resume the session under the Runner (trusted cwd, bypass). Throws on failure. */
  adopt: (req: { sessionId: string; cwd: string; rawModel: string | null; permissionMode: PermissionMode }) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  quietMs?: number;
  exitWaitMs?: number;
  pollMs?: number;
  platform?: NodeJS.Platform;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * Closes the terminal claude of `sessionId` and adopts the session into the Runner. Every refusal happens before the
 * kill; an error after it means the process is already gone (the transcript is intact, "เปิดทำงานต่อ" still works).
 * Resolves with the pid that was closed.
 */
export async function takeover(sessionId: string, d: TakeoverDeps): Promise<number> {
  const log = d.log ?? (() => {});
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const imageName = d.imageName ?? defaultImageName;
  const kill = d.kill ?? defaultKill;
  const refuse = (reason: string, thai: string, extra: Record<string, unknown> = {}): never => {
    log({ cmd: 'takeover', stage: 'refused', sessionId, reason, ...extra });
    throw new CommandError(thai);
  };

  if ((d.platform ?? process.platform) !== 'win32') refuse('platform', 'ยึดมาคุมใช้ได้เฉพาะบน Windows');
  if (d.isRunnerJob(sessionId)) refuse('runner-job', 'งานนี้คุมจากเว็บอยู่แล้ว');
  if (d.isClip(sessionId)) refuse('clip', 'นี่คือคลิปจาก Clip Studio — ไม่ใช่ session ใน terminal');
  const info = d.snapshot().find((s) => s.sessionId === sessionId);
  if (!info) refuse('unknown', 'ไม่พบ session นี้ (ที่เปิดใน terminal บนเครื่องนี้)');
  const i = info as SessionInfo;

  // The pid comes from the sessions file read now, never from the client.
  const files = findSessionFiles(d.sessionsDir ?? defaultSessionsDir(), sessionId).filter((f) => d.pidAlive(f.pid));
  if (files.length === 0) refuse('no-live-pid', 'terminal ของ session นี้ปิดไปแล้ว — กด "ย้ายมาคุมจากเว็บ" แทน');
  if (files.length > 1) refuse('ambiguous-pid', 'มีมากกว่าหนึ่ง process ที่อ้าง session นี้ — ปิดเองใน terminal', { pids: files.map((f) => f.pid) });
  const file = files[0];
  if (file.kind !== 'interactive') refuse('kind', 'ไม่ใช่ session แบบ terminal (interactive)', { pid: file.pid, kind: file.kind });

  const image = await imageName(file.pid).catch(() => null);
  if (!image || image.toLowerCase() !== TAKEOVER_IMAGE) refuse('image', `process ${file.pid} ไม่ใช่ ${TAKEOVER_IMAGE} — ไม่ปิดให้`, { pid: file.pid, image });

  // Idle only. The status in the file is Claude's own word; the rest is what the transcript shows.
  const fileBusy = file.status !== '' && file.status !== 'idle';
  const asking = (i.waitItems?.length ?? 0) > 0;
  const subRunning = i.subagents.some((a) => a.status === 'running' && !a.finished);
  const fresh = now() - i.lastActivity < (d.quietMs ?? TAKEOVER_QUIET_MS);
  if (fileBusy || i.status === 'running' || i.status === 'waiting' || asking || subRunning || fresh) {
    refuse('busy', BUSY_ERROR, { pid: file.pid, fileStatus: file.status, status: i.status, asking, subRunning, fresh });
  }

  log({ cmd: 'takeover', stage: 'kill', sessionId, pid: file.pid });
  try {
    await kill(file.pid);
  } catch (e) {
    if (d.pidAlive(file.pid)) {
      log({ cmd: 'takeover', stage: 'failed', sessionId, pid: file.pid, error: `kill: ${e instanceof Error ? e.message : String(e)}` });
      throw new CommandError('ปิด claude ใน terminal ไม่สำเร็จ');
    }
  }
  const deadline = now() + (d.exitWaitMs ?? TAKEOVER_EXIT_WAIT_MS);
  while (d.pidAlive(file.pid)) {
    if (now() >= deadline) {
      log({ cmd: 'takeover', stage: 'failed', sessionId, pid: file.pid, error: 'pid still alive after wait' });
      throw new CommandError('สั่งปิด claude แล้วแต่ process ยังไม่หายใน 10 วินาที');
    }
    await sleep(d.pollMs ?? TAKEOVER_POLL_MS);
  }
  try {
    d.adopt({ sessionId, cwd: file.cwd || i.cwd, rawModel: i.model, permissionMode: TAKEOVER_MODE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log({ cmd: 'takeover', stage: 'failed', sessionId, pid: file.pid, error: `adopt: ${msg}` });
    throw new CommandError(`ปิด claude ใน terminal แล้ว แต่เปิดต่อไม่สำเร็จ: ${msg} — ข้อมูลงานยังอยู่ กด "เปิดทำงานต่อ" ได้`);
  }
  log({ cmd: 'takeover', stage: 'done', sessionId, pid: file.pid, ok: true });
  return file.pid;
}
