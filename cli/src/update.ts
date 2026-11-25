// `cr update`: runs the server updater (scripts/update.mjs) from the repo root. No server is needed, because the updater
// stops and restarts the server itself. Stdio is inherited so the progress shows in the terminal; its exit code is kept.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from './args.ts';

export type UpdateCommand = Extract<Command, { kind: 'update' }>;

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Arguments for `node scripts/update.mjs`, from a parsed `cr update`. */
export function updateScriptArgs(cmd: UpdateCommand): string[] {
  const args = [path.join(REPO_ROOT, 'scripts', 'update.mjs')];
  if (cmd.tag !== undefined) args.push('--tag', cmd.tag);
  if (cmd.latest) args.push('--latest');
  if (cmd.skills) args.push('--skills');
  if (cmd.dryRun) args.push('--dry-run');
  return args;
}

export function runUpdateCommand(cmd: UpdateCommand, spawn: typeof spawnSync = spawnSync): number {
  const r = spawn(process.execPath, updateScriptArgs(cmd), { cwd: REPO_ROOT, stdio: 'inherit', windowsHide: true });
  if (r.error) {
    console.error(`เรียกตัวอัปเดตไม่ได้: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}
