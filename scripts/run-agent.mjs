#!/usr/bin/env node
// Runs the agent as a child process and records its PID in <dataDir>/agent.pid so agent-setup.mjs
// can stop exactly this agent on update. Started hidden by scripts/start-agent-hidden.vbs.
// One process only: node --import tsx (the tsx CLI would spawn a second node, and its PID is not the listener's).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.CR_DATA_DIR || path.join(os.homedir(), '.claude-control-room');
const pidFile = path.join(dataDir, 'agent.pid');
const script = path.join(repo, 'server', 'src', 'index.ts');
const args = ['--import', 'tsx', script, '--agent'];

fs.mkdirSync(dataDir, { recursive: true });
const child = spawn(process.execPath, args, { cwd: repo, stdio: 'inherit', windowsHide: true, env: process.env });
fs.writeFileSync(pidFile, `${child.pid}\n`);
console.log(`[run-agent] started pid ${child.pid}`);

// Forward a stop request to the agent so it can shut down cleanly.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}

child.on('exit', (code, signal) => {
  // Remove the PID file only if it still names this child (a newer agent may already own it).
  try {
    if (fs.readFileSync(pidFile, 'utf8').trim() === String(child.pid)) fs.rmSync(pidFile, { force: true });
  } catch {
    // no pid file: nothing to clean up
  }
  console.log(`[run-agent] agent exited (${signal ?? `code ${code}`})`);
  process.exitCode = code ?? 1;
});
