// Updates a managed Claude Control Room install to a release tag (see scripts/update-lib.mjs for the steps).
// Usage: node scripts/update.mjs [--app <dir>] [--tag vX.Y.Z | --latest] [--pid N] [--port N] [--data-dir <dir>]
//                                [--skills] [--dry-run] [--yes]
// Exit codes: 0 ok, 2 refused or bad arguments, 3 failed (rolled back, or nothing changed), 4 rollback failed.
// Progress goes to stdout and to <dataDir>/update.log. Tests import this file; it only runs main() when it is the entry.
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseUpdateArgs, realDeps, runUpdate } from './update-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function main(argv, env = process.env) {
  const parsed = parseUpdateArgs(argv);
  if (!parsed.ok) {
    console.error(`refused: ${parsed.error}`);
    return 2;
  }
  const o = parsed.opts;
  const appDir = path.resolve(o.app ?? path.join(HERE, '..'));
  const dataDir = path.resolve(o.dataDir || env.CR_DATA_DIR || path.join(os.homedir(), '.claude-control-room'));
  const deps = realDeps();
  if (!o.yes && !o.dryRun && process.stdin.isTTY) {
    deps.confirm = async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
      rl.close();
      return /^y(es)?$/i.test(answer.trim());
    };
  }
  return runUpdate(
    { appDir, tag: o.tag, latest: o.latest, pid: o.pid, port: o.port, dataDir, skills: o.skills, dryRun: o.dryRun },
    deps,
  );
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`update failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 3;
    },
  );
}
