// "เปิดใน terminal": opens a new Windows Terminal window running `cr attach <sessionId>` for a live Runner job.
// Everything is passed as an argument array (no shell string), the session id is a strict uuid, and the title is
// reduced to harmless characters (wt.exe treats `;` as a command separator, cmd.exe treats & | < > ^ % specially).
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodedError } from './codedError';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TITLE_MAX = 60;

export interface TerminalRequest {
  sessionId: string;
  title: string;
  cwd: string;
}

export interface Launch {
  file: string;
  args: string[];
}

/** Window title: no control characters, no `;` and no cmd metacharacters, one line, at most TITLE_MAX chars. */
export function cleanTitle(raw: string, fallback = 'Claude job'): string {
  // eslint-disable-next-line no-control-regex
  let t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[;&|<>^%"`!]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > TITLE_MAX) t = `${t.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  // a leading '-' would read as a wt option
  t = t.replace(/^-+/, '').trim();
  return t || fallback;
}

/** The command that runs inside the new window. `port` is an argument: a window opened through an already running wt may not inherit our env. */
export function crCommand(nodeBin: string, cliEntry: string, sessionId: string, port: number): string[] {
  return [nodeBin, cliEntry, 'attach', sessionId, '--port', String(port)];
}

/** wt.exe: new window, tab title, start directory, then the command. `;` in the folder is escaped as wt expects. */
export function buildWtLaunch(req: TerminalRequest, command: string[]): Launch {
  if (!UUID_RE.test(req.sessionId)) throw new Error('bad session id');
  return {
    file: 'wt.exe',
    args: ['-w', 'new', '--title', cleanTitle(req.title), '-d', req.cwd.replace(/;/g, '\\;'), ...command],
  };
}

/** Fallback when wt.exe is missing: `cmd /c start "<title>" /D <cwd> <command>` (opens a classic console window). */
export function buildCmdLaunch(req: TerminalRequest, command: string[]): Launch {
  if (!UUID_RE.test(req.sessionId)) throw new Error('bad session id');
  return { file: 'cmd.exe', args: ['/c', 'start', cleanTitle(req.title), '/D', req.cwd, ...command] };
}

export type SpawnLike = (file: string, args: string[]) => ChildProcess;

const defaultSpawn: SpawnLike = (file, args) => nodeSpawn(file, args, { stdio: 'ignore', detached: true, windowsHide: false, shell: false });

export interface TerminalLauncherOptions {
  port: () => number;
  nodeBin?: string;
  cliEntry?: string;
  spawn?: SpawnLike;
  platform?: NodeJS.Platform;
}

/** Entry file of the terminal client, relative to this file (server/src -> cli/src/cr.ts). */
export function defaultCliEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cli/src/cr.ts');
}

export class TerminalLauncher {
  private readonly o: TerminalLauncherOptions;
  constructor(o: TerminalLauncherOptions) {
    this.o = o;
  }

  /** Resolves with the launcher used ('wt' or 'cmd'); rejects with a user-facing message. */
  async open(req: TerminalRequest): Promise<'wt' | 'cmd'> {
    if ((this.o.platform ?? process.platform) !== 'win32') throw new CodedError('เปิด terminal ได้เฉพาะบน Windows', 'srv.terminal.windowsOnly');
    const cmd = crCommand(this.o.nodeBin ?? process.execPath, this.o.cliEntry ?? defaultCliEntry(), req.sessionId, this.o.port());
    const run = this.o.spawn ?? defaultSpawn;
    try {
      await this.start(run, buildWtLaunch(req, cmd));
      return 'wt';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CodedError(`เปิด Windows Terminal ไม่สำเร็จ: ${(e as Error).message}`, 'srv.terminal.wtFailed', { msg: (e as Error).message });
      }
    }
    try {
      await this.start(run, buildCmdLaunch(req, cmd));
      return 'cmd';
    } catch (e) {
      throw new CodedError(`เปิด terminal ไม่สำเร็จ: ${(e as Error).message}`, 'srv.terminal.failed', { msg: (e as Error).message });
    }
  }

  private start(run: SpawnLike, l: Launch): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = run(l.file, l.args);
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}
