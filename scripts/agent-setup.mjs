#!/usr/bin/env node
// Runs ON the remote PC (Node ESM, no dependencies). Driven by scripts/install-remote.mjs over SSH.
// Subcommands:
//   token-hash  read a 64-hex sha256 from stdin, store it in <dataDir>/agent-token.sha256
//   autostart   stop the old agent (only the PID recorded in agent.pid, and only if it listens),
//               register the Startup shortcut, start the agent hidden
//   status      prints "agent: listening" (exit 0) or "agent: not listening" (exit 1)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const AGENT_HOST = '127.0.0.1';
export const AGENT_PORT = 8791;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** <dataDir>: CR_DATA_DIR if set, else %USERPROFILE%\.claude-control-room. */
export function dataDirOf(env = process.env, home = os.homedir()) {
  return env.CR_DATA_DIR || path.join(home, '.claude-control-room');
}

export function isTokenHash(s) {
  return /^[0-9a-f]{64}$/.test(String(s).trim());
}

export function parsePid(text) {
  const n = Number.parseInt(String(text).trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function probe(port = AGENT_PORT, host = AGENT_HOST, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (up) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function waitUntilDown(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await probe())) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (s += c));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', reject);
  });
}

async function tokenHash() {
  const hash = (await readStdin()).trim();
  if (!isTokenHash(hash)) throw new Error('stdin must be a 64-character lowercase hex sha256');
  const dir = dataDirOf();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-token.sha256'), `${hash}\n`);
  console.log('token hash stored');
}

/** Launches wscript through Win32_Process.Create. Returns false when WMI refuses (the caller falls back to a plain spawn). */
export function startViaWmi(vbs) {
  const cmdline = 'wscript.exe "' + vbs + '"';
  const ps = "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '" + cmdline.replace(/'/g, "''") + "' }; exit $r.ReturnValue";
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Stops the agent this script recorded (exact PID from agent.pid), then waits for the port to close. */
async function stopRecorded() {
  if (!(await probe())) return true;
  let pid = null;
  try {
    pid = parsePid(fs.readFileSync(path.join(dataDirOf(), 'agent.pid'), 'utf8'));
  } catch {
    pid = null;
  }
  if (pid) {
    try {
      process.kill(pid);
      console.log(`stopped previous agent (pid ${pid})`);
    } catch {
      // already gone or not ours to stop: the port check below decides
    }
    await waitUntilDown(10000);
  }
  return !(await probe());
}

async function autostart() {
  const dir = dataDirOf();
  fs.mkdirSync(dir, { recursive: true });
  const pidFile = path.join(dir, 'agent.pid');

  // Startup shortcut (per user, no admin).
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'scripts', 'install-agent-autostart.ps1')],
    { cwd: REPO, stdio: 'inherit', windowsHide: true },
  );


  if (!(await stopRecorded())) {
    console.log('already running (restart it after an update: end the agent process on this PC, then run install again)');
    return 0;
  }

  // Start now, hidden: start-agent-hidden.vbs -> run-agent.mjs writes agent.pid. Windows OpenSSH may kill what an ssh
  // session started when the session ends, so the launch goes through WMI (the process is not a child of sshd).
  const vbs = path.join(REPO, 'scripts', 'start-agent-hidden.vbs');
  if (!startViaWmi(vbs)) {
    const child = spawn('wscript.exe', [vbs], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  console.log(`agent starting hidden on ${AGENT_HOST}:${AGENT_PORT}; log: ${path.join(dir, 'agent.log')}`);
  return 0;
}

async function status() {
  const up = await probe();
  console.log(up ? 'agent: listening' : 'agent: not listening');
  return up ? 0 : 1;
}

export async function run(argv = process.argv.slice(2)) {
  switch (argv[0]) {
    case 'token-hash':
      await tokenHash();
      return 0;
    case 'autostart':
      return autostart();
    case 'status':
      return status();
    case 'stop':
      // Before npm ci: a running agent locks node_modules (esbuild.exe). Never fails the install.
      await stopRecorded();
      return 0;
    default:
      console.error('usage: node scripts/agent-setup.mjs <token-hash|autostart|status|stop>');
      return 2;
  }
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  // exitCode, not process.exit: piped stdout may still be flushing and process.exit can truncate it.
  run().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
