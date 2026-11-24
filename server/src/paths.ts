import os from 'node:os';
import path from 'node:path';

/** Claude Code data root. CR_CLAUDE_DIR overrides it (tests point it at a temp dir). */
export function claudeDir(): string {
  const override = process.env.CR_CLAUDE_DIR;
  return override && override.trim() !== '' ? override : path.join(os.homedir(), '.claude');
}

export function sessionsDir(root: string = claudeDir()): string {
  return path.join(root, 'sessions');
}

export function projectsDir(root: string = claudeDir()): string {
  return path.join(root, 'projects');
}
