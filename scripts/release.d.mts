// Type declarations for scripts/release.mjs (used by server/test/release.test.ts).

export interface BumpChange {
  file: string;
  from: string | null;
  to: string;
}

export interface LeakHit {
  file: string;
  line: number;
  label: string;
  match: string;
}

export interface PlanStep {
  id: string;
  title: string;
}

export interface ReleasePlan {
  mode: 'dry-run' | 'apply';
  version: string;
  tag: string;
  date: string;
  source: string;
  publicDir: string;
  workDir: string;
  notesFile: string;
  steps: PlanStep[];
  push: string;
  release: string;
}

export interface PlanOptions {
  version: string;
  apply?: boolean;
  source?: string;
  publicDir?: string;
  out?: string;
  notesFile?: string;
  skipTests?: boolean;
  now?: Date;
}

export const DROP_LIST: string[];

export function isValidVersion(version: string): boolean;
// True when candidate is a valid X.Y.Z strictly greater than current.
export function isNewerVersion(candidate: string, current: string): boolean;
// Sets "version" in root and workspace package.json files and in package-lock.json. Returns changed files.
export function bumpVersions(rootDir: string, version: string): BumpChange[];
// Prepends "## [version] - date" with bullets (from notes text) under the "# Changelog" header.
export function prependChangelog(
  existing: string | null,
  version: string,
  date: string,
  notes: string,
): string;
// Returns the subset of paths that the snapshot must drop.
export function filterDropped(paths: string[]): string[];
// Leak scan over the text files under dir. extraPatterns are case-insensitive regex sources.
export function scanLeaks(dir: string, extraPatterns?: string[]): LeakHit[];
// Reads extra leak regexes from CR_LEAK_PATTERNS or <CR_DATA_DIR or ~/.claude-control-room>/leak-patterns.txt.
export function loadLeakPatterns(env?: NodeJS.ProcessEnv, homeDir?: string): string[];
// Describes a release without touching files or git.
export function planRelease(opts: PlanOptions): ReleasePlan;
// CLI entry point. Returns the exit code: 0 ok, 1 release failed, 2 usage error.
export function main(
  argv?: string[],
  env?: NodeJS.ProcessEnv,
  log?: (line: string) => void,
): number;
