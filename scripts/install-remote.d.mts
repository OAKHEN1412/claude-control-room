// Type declarations for scripts/install-remote.mjs (used by server/test/installRemote.test.ts).

export interface SshTarget {
  host: string;
  user: string;
  keyPath: string;
}

export interface PollSpec {
  cmd: string;
  args: string[];
  timeoutMs: number;
  intervalMs: number;
}

export interface PlanStep {
  name: string;
  cmd: string;
  args: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  check?: 'node>=22';
  poll?: PollSpec;
}

export interface BuildPlanOpts {
  tarPath?: string;
  sha256?: string;
  repoRoot?: string;
  /** The remote PC's profile dir (from resolveRemoteHome). Required: buildPlan throws without it. */
  remoteHome: string;
}

export interface RemotePaths {
  dir: string;
  tar: string;
  tarScp: string;
}

export type RunRemote = (target: SshTarget, remoteCmd: string) => string;

export function tokenEnvName(machineId: string): string;
export function sha256Hex(s: string): string;
export function sshBaseArgs(target: SshTarget): string[];
export function scpArgs(target: SshTarget, localFile: string, remotePath: string): string[];
export function validateTarget(target: SshTarget, sshDir?: string): string | null;
export function parseRemoteHome(stdout: string): string;
export function remotePaths(home: string): RemotePaths;
export function resolveRemoteHome(target: SshTarget, run?: RunRemote): string;
export function buildPlan(target: SshTarget, opts?: BuildPlanOpts): PlanStep[];
export function main(argv?: string[], env?: NodeJS.ProcessEnv): Promise<number>;
