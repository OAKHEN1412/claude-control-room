// Type declarations for scripts/lemo-styles.mjs (used by server/test/lemoStyles.test.ts).

export interface LemoStyleRow {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  stylePath: string;
  thumb: string | null;
}

export interface LemoSkipped {
  dir: string;
  reason: string;
}

export interface BuildResult {
  styles: LemoStyleRow[];
  skipped: LemoSkipped[];
}

export interface LemoArgs {
  lib?: string;
  out?: string;
  dryRun: boolean;
  help: boolean;
  unknown: string[];
}

export function buildLemoStyles(libDir: string): BuildResult;
export function isLemoLibrary(libDir: string): boolean;
export function parseLemoArgs(argv?: string[]): LemoArgs;
export function resolveLibDir(env?: NodeJS.ProcessEnv, argv?: string[]): string;
export function resolveOutFile(env?: NodeJS.ProcessEnv, argv?: string[]): string;
export function writeLemoStyles(
  libDir: string,
  outFile: string,
): { count: number; outFile: string; skipped: LemoSkipped[] };
export function main(argv?: string[], env?: NodeJS.ProcessEnv): number;
