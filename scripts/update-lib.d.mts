// Type declarations for scripts/update-lib.mjs (used by server/test/updater.test.ts and the server's canUpdate).

export type ExitCode = 0 | 2 | 3 | 4;
export declare const EXIT: { readonly OK: 0; readonly REFUSED: 2; readonly FAILED: 3; readonly ROLLBACK_FAILED: 4 };
export declare const MARKER_FILE: '.cr-install';
export declare const DEFAULT_PORT: 8790;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface FsHelpers {
  exists(p: string): boolean;
  /** null when the file is missing. */
  readText(p: string): string | null;
  writeText(p: string, s: string): void;
  appendText(p: string, s: string): void;
  mkdirp(p: string): void;
  realpath(p: string): string;
}

export interface UpdaterDeps extends FsHelpers {
  run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult>;
  fetchFn(url: string): Promise<{ status: number }>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  isAlive(pid: number): boolean;
  killTree(pid: number): Promise<void>;
  startServer(appDir: string, opts?: { port?: number }): Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
  /** The updater's own pid, never killed. Defaults to process.pid. */
  selfPid?: number;
  /** Interactive confirmation; absent = no prompt. */
  confirm?(question: string): Promise<boolean>;
}

export type PlanStep =
  | { id: 'check'; kind: 'check' }
  | { id: string; kind: 'cmd'; cmd: string; args: string[]; cwd: string; mandatory: boolean; capture?: 'prevRef' }
  | { id: string; kind: 'stop'; pid: number | null; port: number; fallbackToPort: boolean; mandatory: true }
  | { id: string; kind: 'start'; appDir: string; port: number; mandatory: true }
  | { id: string; kind: 'health'; port: number; mandatory: true }
  | { id: string; kind: 'marker'; tag: string; mandatory: true };

export type RefusalReason = 'no-marker' | 'not-git' | 'dirty-tree';

export function isValidTag(tag: unknown): tag is string;
export function redact(text: string): string;
export function latestTag(names: string[]): string | null;
export function parseLsRemoteTags(stdout: string): string[];
export function parseNetstatPids(stdout: string, port: number): number[];
export function readMarker(appDir: string, deps: Pick<UpdaterDeps, 'readText'>): Record<string, unknown> | null;
export function managedInstallProblem(appDir: string, deps: UpdaterDeps): Promise<RefusalReason | null>;
export function planUpdate(opts: { appDir: string; tag: string; withSkills?: boolean; port?: number; pid?: number | null }): PlanStep[];
export function planRollback(opts: { appDir: string; prevRef: string; port: number; pid?: number | null }): PlanStep[];
export function describeStep(s: PlanStep): string;
export function healthCheck(port: number, deps: Pick<UpdaterDeps, 'fetchFn' | 'sleep'>): Promise<boolean>;

export interface UpdateOpts {
  appDir: string;
  tag?: string | null;
  latest?: boolean;
  pid?: number | null;
  port?: number | null;
  dataDir: string;
  skills?: boolean;
  dryRun?: boolean;
}
export function runUpdate(opts: UpdateOpts, deps: UpdaterDeps): Promise<ExitCode>;

export interface ParsedUpdateArgs {
  app: string | null;
  tag: string | null;
  latest: boolean;
  pid: number | null;
  port: number | null;
  dataDir: string | null;
  skills: boolean;
  dryRun: boolean;
  yes: boolean;
}
export function parseUpdateArgs(argv: string[]): { ok: true; opts: ParsedUpdateArgs } | { ok: false; error: string };

export interface SpawnedChild {
  unref(): void;
  pid?: number;
}
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { detached: boolean; stdio: 'ignore'; windowsHide: boolean; windowsVerbatimArguments?: boolean },
) => SpawnedChild;
export function spawnUpdaterDetached(
  opts: { appDir: string; tag: string; pid?: number | null; port?: number | null; dataDir?: string; skills?: boolean },
  spawnFn?: SpawnFn,
): { ok: true; pid?: number } | { ok: false; error: string };

export declare const fsHelpers: FsHelpers;
export function realDeps(): UpdaterDeps;
