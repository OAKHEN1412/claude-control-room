// Updater core for Claude Control Room. Plans and runs an in-place update of a managed install: a checkout made by
// install.ps1 that carries the .cr-install marker. Every side effect goes through `deps` (run, fetchFn, fs helpers,
// sleep, killTree, startServer, log lines), so tests drive the whole flow with fakes. Plain ESM, node built-ins only,
// no top-level side effects (tests import this file).
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MARKER_FILE = '.cr-install';
export const DEFAULT_PORT = 8790;
export const EXIT = Object.freeze({ OK: 0, REFUSED: 2, FAILED: 3, ROLLBACK_FAILED: 4 });

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const HEALTH_TRIES = 60;
const HEALTH_INTERVAL_MS = 1000;
const HEALTH_FETCH_MS = 3000;
const REFUSAL_TEXT = {
  'no-marker': 'not a managed install (no .cr-install marker)',
  'not-git': 'the app folder is not its own git checkout',
  'dirty-tree': 'the git working tree has local changes (or its state could not be read)',
};
const WIN_CMD_SHIMS = new Set(['npm', 'npx', 'claude']);

export function isValidTag(tag) {
  return typeof tag === 'string' && TAG_RE.test(tag);
}
export function isValidPid(n) {
  return Number.isInteger(n) && n > 0;
}
export function isValidPort(n) {
  return Number.isInteger(n) && n > 0 && n < 65536;
}

/** Hides credentials that can show up in git/npm error text (user:pass@host URLs, tokens, key=value secrets). */
export function redact(text) {
  return String(text)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '***')
    .replace(/\b(token|password|passwd|secret|authorization|api[_-]?key)(\s*[=:]\s*)\S+/gi, '$1$2***');
}

/** Highest vX.Y.Z among the names (other names are ignored). */
export function latestTag(names) {
  const tags = names.filter(isValidTag).map((t) => ({ t, v: t.slice(1).split('.').map(Number) }));
  tags.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.v[i] !== b.v[i]) return a.v[i] - b.v[i];
    return 0;
  });
  return tags.length ? tags[tags.length - 1].t : null;
}

/** Tag names from `git ls-remote --tags --refs origin` output. */
export function parseLsRemoteTags(stdout) {
  const names = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /\srefs\/tags\/(\S+)\s*$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Distinct PIDs LISTENING on the port, from `netstat -ano -p TCP` output. */
export function parseNetstatPids(stdout, port) {
  const pids = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[2]) === port) pids.add(Number(m[3]));
  }
  return [...pids];
}

/** Real filesystem helpers. readText gives null for a missing file. */
export const fsHelpers = {
  exists: (p) => fs.existsSync(p),
  readText: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
  },
  writeText: (p, s) => fs.writeFileSync(p, s, 'utf8'),
  appendText: (p, s) => fs.appendFileSync(p, s, 'utf8'),
  mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  realpath: (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  },
};

function normDir(p) {
  const s = String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function markerPath(appDir) {
  return path.join(appDir, MARKER_FILE);
}

/** The parsed marker object, or null when it is missing or not a JSON object. */
export function readMarker(appDir, deps) {
  let raw;
  try {
    raw = deps.readText(markerPath(appDir));
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

/**
 * null when appDir is a managed install that can be updated, else 'no-marker' | 'not-git' | 'dirty-tree'.
 * Dirty = tracked changes, or untracked files that git does not ignore (the marker itself does not count).
 * The server's canUpdate calls this too.
 */
export async function managedInstallProblem(appDir, deps) {
  if (!readMarker(appDir, deps)) return 'no-marker';
  const cwd = appDir;
  const top = await deps.run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (top.code !== 0 || normDir(top.stdout) !== normDir(deps.realpath(appDir))) return 'not-git';
  const tracked = await deps.run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd });
  if (tracked.code !== 0 || tracked.stdout.trim() !== '') return 'dirty-tree';
  const untracked = await deps.run('git', ['ls-files', '--others', '--exclude-standard'], { cwd });
  if (untracked.code !== 0) return 'dirty-tree';
  const extra = untracked.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => f.replace(/\\/g, '/') !== MARKER_FILE);
  return extra.length ? 'dirty-tree' : null;
}

/**
 * Ordered steps for an update to `tag`. Pure. Kinds: check (refusal, done by runUpdate), cmd (a process; mandatory or
 * warning-only), stop (exact pid, or the listener of the port), start, health, marker.
 */
export function planUpdate({ appDir, tag, withSkills = false, port = DEFAULT_PORT, pid = null }) {
  if (!isValidTag(tag)) throw new Error(`bad tag ${tag}`);
  const cwd = appDir;
  const steps = [
    { id: 'check', kind: 'check' },
    { id: 'record-prev', kind: 'cmd', cmd: 'git', args: ['rev-parse', 'HEAD'], cwd, mandatory: true, capture: 'prevRef' },
    { id: 'fetch', kind: 'cmd', cmd: 'git', args: ['fetch', '--tags', '--force', 'origin'], cwd, mandatory: true },
    { id: 'verify-tag', kind: 'cmd', cmd: 'git', args: ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], cwd, mandatory: true },
    // Stopped only after every step that can fail without harm (network, verify): on Windows the running server locks
    // node_modules (esbuild.exe), so npm ci needs it down.
    { id: 'stop-server', kind: 'stop', pid, port, fallbackToPort: false, mandatory: true },
    { id: 'checkout', kind: 'cmd', cmd: 'git', args: ['checkout', '--detach', tag], cwd, mandatory: true },
    { id: 'npm-ci', kind: 'cmd', cmd: 'npm', args: ['ci'], cwd, mandatory: true },
    { id: 'build', kind: 'cmd', cmd: 'npm', args: ['run', 'build'], cwd, mandatory: true },
    { id: 'lemo-styles', kind: 'cmd', cmd: 'node', args: ['scripts/lemo-styles.mjs'], cwd, mandatory: false },
  ];
  if (withSkills) {
    steps.push(
      { id: 'skills-update', kind: 'cmd', cmd: 'npx', args: ['--yes', 'skills', 'update', '-g', '-y'], cwd, mandatory: false },
      { id: 'plugin-marketplace', kind: 'cmd', cmd: 'claude', args: ['plugin', 'marketplace', 'update'], cwd, mandatory: false },
      { id: 'plugin-lemo', kind: 'cmd', cmd: 'claude', args: ['plugin', 'update', 'lemo-opuscar@lemolab'], cwd, mandatory: false },
    );
  }
  steps.push(
    { id: 'start-server', kind: 'start', appDir, port, mandatory: true },
    { id: 'health', kind: 'health', port, mandatory: true },
    { id: 'write-marker', kind: 'marker', tag, mandatory: true },
  );
  return steps;
}

/**
 * Rollback after a failure past checkout: stop the (possibly restarted) server, previous commit, deps, build, restart,
 * health. Marker untouched. The stop goes first and is non-fatal when the server is already gone (dead pid, no listener).
 */
export function planRollback({ appDir, prevRef, port, pid = null }) {
  const cwd = appDir;
  return [
    { id: 'stop-server', kind: 'stop', pid, port, fallbackToPort: true, mandatory: true },
    { id: 'checkout', kind: 'cmd', cmd: 'git', args: ['checkout', '--detach', prevRef], cwd, mandatory: true },
    { id: 'npm-ci', kind: 'cmd', cmd: 'npm', args: ['ci'], cwd, mandatory: true },
    { id: 'build', kind: 'cmd', cmd: 'npm', args: ['run', 'build'], cwd, mandatory: true },
    { id: 'start-server', kind: 'start', appDir, port, mandatory: true },
    { id: 'health', kind: 'health', port, mandatory: true },
  ];
}

export function describeStep(s) {
  switch (s.kind) {
    case 'check':
      return 'refusal check (managed install, clean tree)';
    case 'cmd':
      return `${s.id}: ${s.cmd} ${s.args.join(' ')}${s.mandatory ? '' : ' (warning only)'}`;
    case 'stop':
      return s.pid != null
        ? `stop-server: taskkill pid ${s.pid} (only if it is alive)`
        : `stop-server: the single listener on port ${s.port} (netstat)`;
    case 'start':
      return `start-server: port ${s.port}`;
    case 'health':
      return `health: GET http://127.0.0.1:${s.port}/ for up to 60 s`;
    case 'marker':
      return `write-marker: .cr-install tag ${s.tag}`;
    default:
      return s.kind;
  }
}

/** Polls GET / once a second for up to 60 tries; true on a 2xx answer. */
export async function healthCheck(port, deps) {
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < HEALTH_TRIES; i++) {
    try {
      const r = await deps.fetchFn(url);
      if (r && r.status >= 200 && r.status < 300) return true;
    } catch {
      /* not answering yet */
    }
    if (i < HEALTH_TRIES - 1) await deps.sleep(HEALTH_INTERVAL_MS);
  }
  return false;
}

function tail(text, max = 300) {
  const t = redact(String(text ?? '')).trim();
  return t.length > max ? `...${t.slice(-max)}` : t;
}

async function killAndConfirm(pid, ctx) {
  const self = ctx.deps.selfPid ?? process.pid;
  if (pid === self) throw new Error('refusing to stop the updater itself');
  await ctx.deps.killTree(pid);
  if (ctx.deps.isAlive(pid)) throw new Error(`pid ${pid} is still running after the stop`);
  ctx.say(`stopped pid ${pid}`);
}

async function stopServer(s, ctx) {
  const { deps, say } = ctx;
  if (s.pid != null && deps.isAlive(s.pid)) {
    say(`stop: pid ${s.pid} (the --pid given)`);
    await killAndConfirm(s.pid, ctx);
    return;
  }
  if (s.pid != null) say(`stop: pid ${s.pid} is not running`);
  const ns = await deps.run('netstat', ['-ano', '-p', 'TCP'], {});
  if (ns.code !== 0) throw new Error('netstat failed; cannot find the server on the port');
  const pids = parseNetstatPids(ns.stdout, s.port);
  if (pids.length === 0) {
    say(`stop: nothing listens on port ${s.port}`);
    return;
  }
  if (pids.length > 1) throw new Error(`more than one process listens on port ${s.port} (${pids.join(', ')}); not stopping`);
  if (s.pid != null && !s.fallbackToPort) throw new Error(`port ${s.port} is held by pid ${pids[0]}, not the --pid given`);
  say(`stop: pid ${pids[0]} listens on port ${s.port}`);
  await killAndConfirm(pids[0], ctx);
}

async function execStep(s, ctx) {
  const { deps, say } = ctx;
  switch (s.kind) {
    case 'cmd': {
      say(`${s.id}: ${s.cmd} ${s.args.join(' ')}`);
      if (s.id === 'checkout') ctx.state.checkedOut = true;
      let r;
      try {
        r = await deps.run(s.cmd, s.args, { cwd: s.cwd });
      } catch (e) {
        r = { code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
      }
      if (r.code !== 0) {
        const msg = `${s.id} exited ${r.code}${tail(r.stderr) ? `: ${tail(r.stderr)}` : ''}`;
        if (!s.mandatory) {
          say(`warning (update continues): ${msg}`, true);
          return;
        }
        throw new Error(msg);
      }
      if (s.capture === 'prevRef') {
        const sha = String(r.stdout).trim();
        if (!SHA_RE.test(sha)) throw new Error('could not read the current commit');
        ctx.state.prevRef = sha;
        say(`previous commit ${sha}`);
      }
      return;
    }
    case 'stop':
      return stopServer(s, ctx);
    case 'start':
      say(`start-server: port ${s.port}`);
      await deps.startServer(s.appDir, { port: s.port });
      return;
    case 'health':
      say(`health: GET http://127.0.0.1:${s.port}/ (up to 60 s)`);
      if (!(await healthCheck(s.port, deps))) throw new Error(`health check on port ${s.port} did not answer 2xx`);
      say('health: ok');
      return;
    case 'marker': {
      const existing = readMarker(ctx.appDir, deps) ?? {};
      const next = { ...existing, tag: s.tag, updatedAt: deps.now().toISOString() };
      deps.writeText(markerPath(ctx.appDir), `${JSON.stringify(next, null, 2)}\n`);
      say(`marker: tag ${s.tag}`);
      return;
    }
    default:
      throw new Error(`unknown step ${s.kind}`);
  }
}

/** Failure after stop-server but before checkout: the checkout is untouched, so a plain restart brings the server back. */
async function restartOldServer(ctx) {
  const { say } = ctx;
  say('restarting the server on the unchanged code', true);
  try {
    await execStep({ id: 'start-server', kind: 'start', appDir: ctx.appDir, port: ctx.port }, ctx);
    await execStep({ id: 'health', kind: 'health', port: ctx.port }, ctx);
    say('server restarted on the previous code', true);
  } catch (e) {
    say(`could not restart the server: ${e instanceof Error ? e.message : String(e)}; start it by hand`, true);
  }
}

async function rollback(ctx) {
  const { say, state } = ctx;
  if (!state.prevRef) {
    say('rollback impossible: the previous commit is unknown', true);
    return EXIT.ROLLBACK_FAILED;
  }
  say(`rolling back to ${state.prevRef}`);
  try {
    for (const s of planRollback({ appDir: ctx.appDir, prevRef: state.prevRef, port: ctx.port, pid: ctx.pid })) {
      await execStep(s, ctx);
    }
  } catch (e) {
    say(`ROLLBACK FAILED: ${e instanceof Error ? e.message : String(e)}`, true);
    say(`manual recovery: git checkout --detach ${state.prevRef}; npm ci; npm run build; start the server`, true);
    return EXIT.ROLLBACK_FAILED;
  }
  say(`rolled back to ${state.prevRef}; marker unchanged`);
  return EXIT.FAILED;
}

/**
 * Runs the update. opts: { appDir, tag | latest, pid, port, dataDir, skills, dryRun }. Returns the exit code
 * (0 ok, 2 refused, 3 failed and rolled back / nothing changed, 4 rollback failed).
 */
export async function runUpdate(opts, deps) {
  const appDir = path.resolve(opts.appDir);
  const dataDir = opts.dataDir;
  const logFile = path.join(dataDir, 'update.log');
  const say = (line, toErr = false) => {
    const text = redact(line);
    try {
      deps.mkdirp(dataDir);
      deps.appendText(logFile, `[${deps.now().toISOString()}] ${text}\n`);
    } catch {
      /* the log is best effort; the terminal still gets the line */
    }
    (toErr ? deps.stderr : deps.stdout)(text);
  };
  const refuse = (msg) => {
    say(`refused: ${msg}`, true);
    return EXIT.REFUSED;
  };

  const hasTag = opts.tag !== undefined && opts.tag !== null;
  if (hasTag && opts.latest) return refuse('use either --tag or --latest, not both');
  if (!hasTag && !opts.latest) return refuse('give --tag vX.Y.Z or --latest');
  if (hasTag && !isValidTag(opts.tag)) return refuse(`bad tag "${opts.tag}" (expected vX.Y.Z)`);
  const pid = opts.pid ?? null;
  if (pid !== null && !isValidPid(pid)) return refuse(`bad pid ${pid}`);
  if (pid !== null && pid === (deps.selfPid ?? process.pid)) return refuse('--pid is the updater itself');
  if (opts.port != null && !isValidPort(opts.port)) return refuse(`bad port ${opts.port}`);

  const problem = await managedInstallProblem(appDir, deps);
  if (problem) return refuse(REFUSAL_TEXT[problem]);

  const marker = readMarker(appDir, deps) ?? {};
  const port = opts.port ?? (isValidPort(marker.port) ? marker.port : DEFAULT_PORT);

  let tag = hasTag ? opts.tag : null;
  if (opts.latest) {
    const r = await deps.run('git', ['ls-remote', '--tags', '--refs', 'origin'], { cwd: appDir });
    if (r.code !== 0) return refuse('could not list the tags on origin');
    tag = latestTag(parseLsRemoteTags(r.stdout));
    if (!tag) return refuse('no vX.Y.Z tag on origin');
  }

  const steps = planUpdate({ appDir, tag, withSkills: !!opts.skills, port, pid });
  say(
    `plan: ${appDir} from marker tag ${marker.tag ?? 'unknown'} to ${tag} (port ${port}${pid !== null ? `, pid ${pid}` : ''}${opts.skills ? ', with skills' : ''})`,
  );
  for (const s of steps) say(`  ${describeStep(s)}`);
  if (opts.dryRun) {
    say('dry run: nothing was changed');
    return EXIT.OK;
  }
  if (deps.confirm && !(await deps.confirm(`update to ${tag}?`))) return refuse('cancelled');

  const ctx = { deps, say, appDir, port, pid, state: { prevRef: null, checkedOut: false, stopAttempted: false } };
  say(`start: update to ${tag}`);
  try {
    for (const s of steps) {
      if (s.kind === 'check') continue;
      if (s.kind === 'stop') ctx.state.stopAttempted = true;
      await execStep(s, ctx);
    }
  } catch (e) {
    say(`failed: ${e instanceof Error ? e.message : String(e)}`, true);
    if (!ctx.state.checkedOut) {
      say('no files were changed', true);
      // The server was stopped but the old code is intact: start it again on the same code.
      if (ctx.state.stopAttempted) await restartOldServer(ctx);
      return EXIT.FAILED;
    }
    return rollback(ctx);
  }
  say(`done: now on ${tag}`);
  return EXIT.OK;
}

const VALUE_OPTS = new Map([
  ['--app', 'app'],
  ['--tag', 'tag'],
  ['--pid', 'pid'],
  ['--port', 'port'],
  ['--data-dir', 'dataDir'],
]);
const BOOL_OPTS = new Map([
  ['--latest', 'latest'],
  ['--skills', 'skills'],
  ['--dry-run', 'dryRun'],
  ['--yes', 'yes'],
]);

/** CLI arguments of scripts/update.mjs. Returns { ok, opts } or { ok: false, error }. */
export function parseUpdateArgs(argv) {
  const o = { app: null, tag: null, latest: false, pid: null, port: null, dataDir: null, skills: false, dryRun: false, yes: false };
  const bad = (error) => ({ ok: false, error });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (BOOL_OPTS.has(name)) {
      if (eq > 0) return bad(`${name} takes no value`);
      o[BOOL_OPTS.get(name)] = true;
      continue;
    }
    if (VALUE_OPTS.has(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === '' || (eq < 0 && v.startsWith('--'))) return bad(`${name} needs a value`);
      o[VALUE_OPTS.get(name)] = v;
      continue;
    }
    return bad(`unknown argument ${a}`);
  }
  if (o.tag !== null && o.latest) return bad('use either --tag or --latest, not both');
  if (o.tag === null && !o.latest) return bad('give --tag vX.Y.Z or --latest');
  if (o.tag !== null && !isValidTag(o.tag)) return bad(`bad tag "${o.tag}" (expected vX.Y.Z)`);
  if (o.pid !== null) {
    const n = /^\d+$/.test(o.pid) ? Number(o.pid) : NaN;
    if (!isValidPid(n)) return bad(`bad --pid ${o.pid}`);
    o.pid = n;
  }
  if (o.port !== null) {
    const n = /^\d+$/.test(o.port) ? Number(o.port) : NaN;
    if (!isValidPort(n)) return bad(`bad --port ${o.port}`);
    o.port = n;
  }
  return { ok: true, opts: o };
}

/**
 * Starts scripts/update.mjs detached and returns at once (the server uses this; the server is about to be stopped by
 * the update). On win32 the updater is started through cmd's `start` so it is not a child of the server (see below).
 * Returns { ok } and never throws. spawnFn is injectable for tests.
 */
export function spawnUpdaterDetached({ appDir, tag, pid, port, dataDir, skills = false }, spawnFn = spawn) {
  if (!isValidTag(tag)) return { ok: false, error: `bad tag ${tag}` };
  if (pid != null && !isValidPid(pid)) return { ok: false, error: `bad pid ${pid}` };
  if (port != null && !isValidPort(port)) return { ok: false, error: `bad port ${port}` };
  const app = path.resolve(appDir);
  const args = [path.join(app, 'scripts', 'update.mjs'), '--app', app, '--tag', tag, '--yes'];
  if (pid != null) args.push('--pid', String(pid));
  if (port != null) args.push('--port', String(port));
  if (dataDir) args.push('--data-dir', dataDir);
  if (skills) args.push('--skills');
  try {
    if (process.platform === 'win32') {
      // Through cmd's `start`, so the updater's parent is the short-lived cmd, not this server. The update's stop step
      // runs `taskkill /T` on the server, which walks children by parent pid and would take the updater down with it.
      // cmd quoting: every argument is wrapped in double quotes, so a quote, % or ! in a path cannot be handled safely.
      const parts = [process.execPath, ...args];
      if (parts.some((a) => /["%!\r\n]/.test(a))) {
        return { ok: false, error: 'a path has a quote, %, ! or a line break; the updater was not started' };
      }
      const line = `start "" /b ${parts.map((a) => `"${a}"`).join(' ')}`;
      const child = spawnFn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      child?.unref?.();
      return { ok: true };
    }
    const child = spawnFn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child?.unref?.();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: redact(e instanceof Error ? e.message : String(e)) };
  }
}

// ---- real side effects (used by scripts/update.mjs; tests use fakes) ----

function realRun(cmd, args, { cwd, env } = {}) {
  let file = cmd === 'node' ? process.execPath : cmd;
  let argv = args;
  if (process.platform === 'win32' && WIN_CMD_SHIMS.has(cmd)) {
    // npm/npx/claude are .cmd shims that execFile cannot start directly. The command text is fixed in this file.
    file = 'cmd.exe';
    argv = ['/d', '/s', '/c', [cmd, ...args].join(' ')];
  }
  return new Promise((resolve) => {
    execFile(file, argv, { cwd, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const code = typeof err.code === 'number' ? err.code : -1;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr || err.message) });
    });
  });
}

function realKillTree(pid) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, _so, se) => {
        if (err) reject(new Error(`taskkill ${pid} failed: ${String(se || err.message).trim()}`));
        else resolve();
      });
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
      resolve();
    } catch (e) {
      reject(e);
    }
  });
}

function realIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function realStartServer(appDir, { port } = {}) {
  const env = { ...process.env, ...(port ? { PORT: String(port) } : {}) };
  let child;
  if (process.platform === 'win32') {
    child = spawn('wscript.exe', [path.join(appDir, 'scripts', 'start-hidden.vbs')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
  } else {
    child = spawn('npm', ['run', 'start'], { cwd: appDir, detached: true, stdio: 'ignore', env });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function realFetch(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(HEALTH_FETCH_MS) });
  return { status: r.status };
}

/** The deps object the CLI uses. */
export function realDeps() {
  return {
    ...fsHelpers,
    run: realRun,
    fetchFn: realFetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    isAlive: realIsAlive,
    killTree: realKillTree,
    startServer: realStartServer,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    selfPid: process.pid,
  };
}
