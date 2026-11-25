// Installs the Claude Control Room agent on a remote Windows PC over SSH, run from this PC.
// Usage: node scripts/install-remote.mjs <machineId> [--dry-run] [--token-stdin]
//
// Machine data (host, user, key path) comes from the server's SQLite DB, opened read-only.
// The agent token comes from env CR_AGENT_TOKEN_<ID> (or stdin with --token-stdin). It is never printed,
// logged, written to a file or put on a command line: only its sha256 hex goes to the remote.
// Env overrides: CR_DB_FILE (DB path), CR_DATA_DIR (data dir), CR_SSH_DIR (ssh dir, default ~/.ssh).
// Pure helpers are exported so tests can import this file without running main.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Remote paths sit under the remote user's profile dir, which the remote PC reports itself (resolveRemoteHome).
const REMOTE_DIR_NAME = 'claude-control-room-agent';
const REMOTE_TAR_NAME = 'cr-agent-upload.tar';
const REMOTE_HOME_CMD = 'cmd /c echo %USERPROFILE%';
const REMOTE_HOME_RE = /^[A-Za-z]:\\[^"&|<>^%\r\n]*$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SSH_HOST_OPTS = ['-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];
const USAGE = 'usage: node scripts/install-remote.mjs <machineId> [--dry-run] [--token-stdin]';

export function tokenEnvName(machineId) {
  return 'CR_AGENT_TOKEN_' + String(machineId).toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function sha256Hex(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** Checks the remote's answer to `echo %USERPROFILE%` and returns it without trailing backslashes. Throws on anything else. */
export function parseRemoteHome(stdout) {
  const home = String(stdout ?? '').trim();
  if (!REMOTE_HOME_RE.test(home)) throw new Error(`remote home is not a Windows path: ${JSON.stringify(home.slice(0, 200))}`);
  return home.replace(/\\+$/, '');
}

/** Remote install paths under a remote profile dir: Windows form for ssh/cmd, forward-slash form for scp. */
export function remotePaths(home) {
  return {
    dir: `${home}\\${REMOTE_DIR_NAME}`,
    tar: `${home}\\${REMOTE_TAR_NAME}`,
    tarScp: `${home.replace(/\\/g, '/')}/${REMOTE_TAR_NAME}`,
  };
}

function sshExec(target, remote, timeoutMs = 60000) {
  const res = spawnSync('ssh', [...sshBaseArgs(target), remote], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (res.error) throw new Error(`remote home: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`remote home: ssh failed (exit ${res.status ?? res.signal})`);
  return res.stdout || '';
}

/** Asks the remote PC for its profile dir over the same ssh channel. `run(target, remoteCmd)` is injectable (tests stay offline). */
export function resolveRemoteHome(target, run = sshExec) {
  return parseRemoteHome(run(target, REMOTE_HOME_CMD));
}

export function sshBaseArgs({ host, user, keyPath }) {
  return ['-i', keyPath, ...SSH_HOST_OPTS, `${user}@${host}`];
}

export function scpArgs({ host, user, keyPath }, localFile, remotePath) {
  return ['-i', keyPath, ...SSH_HOST_OPTS, localFile, `${user}@${host}:${remotePath}`];
}

function defaultSshDir() {
  return process.env.CR_SSH_DIR || path.join(os.homedir(), '.ssh');
}

/** Returns an error string, or null when the target is safe to pass to ssh/scp. */
export function validateTarget(target, sshDir = defaultSshDir()) {
  const { host, user, keyPath } = target ?? {};
  if (typeof host !== 'string' || !HOST_RE.test(host)) return 'host must be a hostname or IP (letters, digits, dots, dashes; must not start with a dash)';
  if (typeof user !== 'string' || !USER_RE.test(user)) return 'user must be a Windows account name (letters, digits, . _ -)';
  if (typeof keyPath !== 'string' || keyPath === '') return 'key path is empty';
  if (keyPath.split(/[\\/]/).includes('..')) return 'key path must not contain ".."';
  const resolved = path.resolve(keyPath);
  const dir = path.resolve(sshDir);
  if (path.dirname(resolved).toLowerCase() !== dir.toLowerCase()) return `key file must sit directly in ${dir}`;
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    return `key file not found: ${resolved}`;
  }
  if (!st.isFile()) return 'key path is not a file';
  return null;
}

/**
 * Ordered steps for the install. Each step: {name, cmd, args, cwd?, stdin?, timeoutMs?}.
 * The token itself is never an input: only opts.sha256 (hex) reaches the plan.
 * Step 1 carries check:'node>=22'; step 8 carries poll (repeated until the agent listens).
 */
export function buildPlan(target, opts = {}) {
  if (typeof opts.remoteHome !== 'string' || opts.remoteHome === '') {
    throw new Error('buildPlan: opts.remoteHome is required (get it from resolveRemoteHome)');
  }
  const { dir, tar, tarScp } = remotePaths(opts.remoteHome);
  const tarPath = opts.tarPath ?? path.join(os.tmpdir(), 'cr-agent-pack.tar');
  const sha256 = opts.sha256 ?? '<sha256>';
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const ssh = (remote) => [...sshBaseArgs(target), remote];
  const inDir = `cd /d ${dir} && `;
  const agentSetup = (sub) => `${inDir}node scripts\\agent-setup.mjs ${sub}`;
  return [
    { name: 'check node', cmd: 'ssh', args: ssh('node --version'), timeoutMs: 60000, check: 'node>=22' },
    { name: 'pack', cmd: 'git', args: ['archive', '--format=tar', '-o', tarPath, 'HEAD'], cwd: repoRoot, timeoutMs: 120000 },
    { name: 'upload', cmd: 'scp', args: scpArgs(target, tarPath, tarScp), timeoutMs: 600000 },
    {
      name: 'unpack',
      cmd: 'ssh',
      args: ssh(`cmd /c (if not exist ${dir} mkdir ${dir}) && tar -xf ${tar} -C ${dir} && del ${tar}`),
      timeoutMs: 300000,
    },
    { name: 'stop agent', cmd: 'ssh', args: ssh(agentSetup('stop')), timeoutMs: 60000 },
    { name: 'npm ci', cmd: 'ssh', args: ssh(`${inDir}npm ci`), timeoutMs: 600000 },
    { name: 'token hash', cmd: 'ssh', args: ssh(agentSetup('token-hash')), stdin: `${sha256}\n`, timeoutMs: 60000 },
    {
      name: 'autostart',
      cmd: 'ssh',
      args: ssh(agentSetup('autostart')),
      timeoutMs: 120000,
      poll: { cmd: 'ssh', args: ssh(agentSetup('status')), timeoutMs: 30000, intervalMs: 3000 },
    },
  ];
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function loadMachine(id, dbFile) {
  if (!fs.existsSync(dbFile)) throw new Error(`control-room DB not found: ${dbFile}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare('SELECT id, name, host, user, key_path FROM machines WHERE id = ?').get(id) ?? null;
  } finally {
    db.close();
  }
}

async function tokenFor(id, fromStdin, env) {
  const token = fromStdin ? (await readStdin()).trim() : (env[tokenEnvName(id)] ?? '').trim();
  if (!token) {
    throw new Error(`no agent token for "${id}": set ${tokenEnvName(id)} in the environment, or pass --token-stdin. Nothing was generated.`);
  }
  return token;
}

function quoteForShow(a) {
  return /[\s&()]/.test(a) ? `"${a}"` : a;
}

function describeStep(step) {
  const lines = [`  $ ${step.cmd} ${step.args.map(quoteForShow).join(' ')}`];
  if (step.stdin !== undefined) lines.push(`  stdin: ${JSON.stringify(step.stdin)}`);
  if (step.poll) lines.push(`  then poll: ${step.poll.cmd} ${step.poll.args.map(quoteForShow).join(' ')} (every ${step.poll.intervalMs / 1000}s, up to ${step.poll.timeoutMs / 1000}s)`);
  return lines.join('\n');
}

function runStep(step) {
  const res = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    input: step.stdin ?? '',
    encoding: 'utf8',
    timeout: step.timeoutMs ?? 120000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw new Error(`${step.name}: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = `${res.stderr || ''}${res.stdout || ''}`.trim().slice(0, 800);
    throw new Error(`${step.name} failed (exit ${res.status ?? res.signal})${detail ? `: ${detail}` : ''}`);
  }
  return res.stdout || '';
}

function pollAgent(step) {
  const deadline = Date.now() + step.poll.timeoutMs;
  for (;;) {
    const res = spawnSync(step.poll.cmd, step.poll.args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (res.status === 0 && /agent: listening/.test(res.stdout || '')) return;
    if (Date.now() >= deadline) throw new Error('agent did not start listening on 127.0.0.1:8791 within 30 s (see agent.log on the remote PC)');
    sleepSync(step.poll.intervalMs);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  for (const f of flags) {
    if (f !== '--dry-run' && f !== '--token-stdin') throw new Error(`unknown option ${f}\n${USAGE}`);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  const id = positional[0];
  const dryRun = flags.includes('--dry-run');
  const dataDir = env.CR_DATA_DIR || path.join(os.homedir(), '.claude-control-room');
  const dbFile = env.CR_DB_FILE || path.join(dataDir, 'control-room.db');

  const row = await loadMachine(id, dbFile);
  if (!row) throw new Error(`unknown machine id "${id}" (not in the machines table of ${dbFile})`);
  const target = { host: row.host, user: row.user, keyPath: row.key_path };
  const targetErr = validateTarget(target);
  if (targetErr) throw new Error(`machine "${id}": ${targetErr}`);

  const remoteHome = dryRun ? '<remote profile dir>' : resolveRemoteHome(target);
  const rp = remotePaths(remoteHome);
  const tarPath = path.join(os.tmpdir(), `cr-agent-${process.pid}-${randomUUID()}.tar`);
  const sha256 = dryRun ? '<sha256>' : sha256Hex(await tokenFor(id, flags.includes('--token-stdin'), env));
  const plan = buildPlan(target, { tarPath, sha256, remoteHome });

  if (dryRun) {
    console.log(`dry run: install on "${row.name}" (${id}); nothing is executed`);
    plan.forEach((step, i) => {
      console.log(`[${i + 1}/${plan.length}] ${step.name}`);
      console.log(describeStep(step));
    });
    return 0;
  }

  console.log(`installing the agent on "${row.name}" (${id})`);
  try {
    plan.forEach((step, i) => {
      console.log(`[${i + 1}/${plan.length}] ${step.name}`);
      const out = runStep(step);
      if (step.check === 'node>=22') {
        const m = /v(\d+)\./.exec(out);
        if (!m) throw new Error(`could not read remote node version: ${out.trim()}`);
        console.log(`  remote node ${out.trim()}`);
        if (Number(m[1]) < 22) throw new Error(`remote node ${out.trim()} is too old; need 22 or newer`);
      }
      if (step.poll) pollAgent(step);
      console.log('  ok');
    });
  } finally {
    fs.rmSync(tarPath, { force: true });
  }

  console.log('');
  console.log(`ติดตั้ง Claude Control Room Agent บน "${row.name}" เรียบร้อยแล้ว`);
  console.log(`Installed the Claude Control Room agent on "${row.name}".`);
  console.log(`  install dir: ${rp.dir}`);
  console.log('  log: %USERPROFILE%\\.claude-control-room\\agent.log (on the remote PC)');
  console.log('  ต้องติ๊ก "ดู Claude บนเครื่องนี้" ให้เครื่องนี้ใน Control Room ก่อน จึงจะเชื่อมต่อได้');
  console.log('  Tick "ดู Claude บนเครื่องนี้" for this machine in the Control Room before it connects.');
  return 0;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
