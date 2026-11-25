// scripts/update-lib.mjs + scripts/update.mjs: refusals, exact command order, dry run, rollback, pid-only stop,
// warning-only steps, log redaction, detached spawn. Every side effect goes through a fake that records it; the real
// git, npm, taskkill and server are never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeStep,
  EXIT,
  fsHelpers,
  healthCheck,
  latestTag,
  managedInstallProblem,
  parseLsRemoteTags,
  parseNetstatPids,
  parseUpdateArgs,
  planRollback,
  planUpdate,
  redact,
  runUpdate,
  spawnUpdaterDetached,
} from '../../scripts/update-lib.mjs';
import type { RunOpts, RunResult, UpdaterDeps } from '../../scripts/update-lib.mjs';

const PREV = '1234567890abcdef1234567890abcdef12345678';
const TAG_SHA = 'f'.repeat(40);
const READ_ONLY = /^(git (rev-parse|status|ls-files|ls-remote)\b|netstat\b)/;

type Call =
  | { op: 'run'; cmd: string; args: string[]; cwd?: string }
  | { op: 'fetch'; url: string }
  | { op: 'start'; appDir: string; port?: number }
  | { op: 'write'; path: string };

function label(c: Call): string {
  if (c.op === 'run') return [c.cmd, ...c.args].join(' ');
  if (c.op === 'fetch') return `GET ${c.url}`;
  if (c.op === 'start') return 'start-server';
  return `write ${path.basename(c.path)}`;
}

function isMutating(c: Call): boolean {
  if (c.op === 'run') return !READ_ONLY.test([c.cmd, ...c.args].join(' '));
  return c.op === 'start' || c.op === 'write';
}

/** Consecutive duplicates removed, so the 60 health polls read as one GET. */
function collapse(xs: string[]): string[] {
  return xs.filter((x, i) => i === 0 || x !== xs[i - 1]);
}

interface FakeOpts {
  appDir: string;
  alive?: number[];
  listener?: number | null;
  tagsOnOrigin?: string[];
  topLevel?: string;
  selfPid?: number;
  confirm?: boolean;
  /** Overrides a command's result. n = how many times this exact command line has run so far (1-based). */
  respond?: (key: string, n: number) => RunResult | undefined;
  /** Health answers per poll (n = 0-based poll number): an HTTP status, or 'throw' for connection refused. */
  health?: (n: number) => number | 'throw';
}

function makeFake(o: FakeOpts) {
  const calls: Call[] = [];
  const out: string[] = [];
  const errs: string[] = [];
  const sleeps: number[] = [];
  const alive = new Set<number>(o.alive ?? []);
  let listener: number | null = o.listener ?? null;
  const counts = new Map<string, number>();
  let fetchN = 0;
  let nextPid = 5000;
  const toplevel = (o.topLevel ?? fsHelpers.realpath(o.appDir)).replace(/\\/g, '/');
  const listenerLine = (pid: number) => `  TCP    127.0.0.1:8790         0.0.0.0:0              LISTENING       ${pid}\n`;

  const defaults = (key: string): RunResult => {
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
    if (key === 'git rev-parse --show-toplevel') return ok(`${toplevel}\n`);
    if (key === 'git status --porcelain --untracked-files=no') return ok('');
    if (key === 'git ls-files --others --exclude-standard') return ok('');
    if (key === 'git rev-parse HEAD') return ok(`${PREV}\n`);
    if (key.startsWith('git rev-parse --verify refs/tags/')) return ok(`${TAG_SHA}\n`);
    if (key === 'git ls-remote --tags --refs origin') {
      return ok((o.tagsOnOrigin ?? ['v0.2.0']).map((t) => `${'a'.repeat(40)}\trefs/tags/${t}\n`).join(''));
    }
    if (key === 'netstat -ano -p TCP') return ok(listener === null ? '' : listenerLine(listener));
    return ok();
  };

  const deps: UpdaterDeps = {
    ...fsHelpers,
    writeText: (p: string, s: string) => {
      calls.push({ op: 'write', path: p });
      fsHelpers.writeText(p, s);
    },
    async run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
      calls.push({ op: 'run', cmd, args: [...args], cwd: opts.cwd });
      const key = [cmd, ...args].join(' ');
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return o.respond?.(key, n) ?? defaults(key);
    },
    async fetchFn(url: string) {
      const n = fetchN++;
      calls.push({ op: 'fetch', url });
      const h = o.health ? o.health(n) : 200;
      if (h === 'throw') throw new Error('ECONNREFUSED');
      return { status: h };
    },
    async sleep(ms: number) {
      sleeps.push(ms);
    },
    now: () => new Date('2026-11-25T10:00:00.000Z'),
    isAlive: (pid: number) => alive.has(pid),
    async killTree(pid: number) {
      calls.push({ op: 'run', cmd: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] });
      alive.delete(pid);
      if (listener === pid) listener = null;
    },
    async startServer(appDir: string, opts?: { port?: number }) {
      calls.push({ op: 'start', appDir, port: opts?.port });
      const pid = nextPid++;
      alive.add(pid);
      listener = pid;
    },
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => errs.push(l),
    selfPid: o.selfPid ?? 7777,
    ...(o.confirm === undefined ? {} : { confirm: async () => o.confirm as boolean }),
  };
  const labels = () => calls.map(label);
  const mutating = () => calls.filter(isMutating).map(label);
  return { deps, calls, out, errs, sleeps, labels, mutating, collapsed: () => collapse(labels()) };
}

// The happy path with a running server (pid 4242) and tag v0.2.0.
const HEAD_CHECKS = [
  'git rev-parse --show-toplevel',
  'git status --porcelain --untracked-files=no',
  'git ls-files --others --exclude-standard',
  'git rev-parse HEAD',
];

let base: string;
let appDir: string;
let dataDir: string;

function writeMarker(dir: string, body: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.cr-install'), JSON.stringify(body));
}

function readMarkerFile(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, '.cr-install'), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-updater-'));
  appDir = path.join(base, 'app');
  dataDir = path.join(base, 'data');
  writeMarker(appDir, { tag: 'v0.1.0', installedAt: '2026-11-01T00:00:00.000Z' });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function opts(extra: Partial<Parameters<typeof runUpdate>[0]> = {}) {
  return { appDir, dataDir, tag: 'v0.2.0', ...extra };
}

describe('managedInstallProblem', () => {
  it('a folder without the marker is a dev checkout: no-marker, and no command runs at all', async () => {
    const bare = path.join(base, 'dev-checkout');
    fs.mkdirSync(bare);
    const f = makeFake({ appDir: bare });
    expect(await managedInstallProblem(bare, f.deps)).toBe('no-marker');
    expect(f.calls).toEqual([]);
  });

  it('a marker that is not a JSON object still counts as no marker', async () => {
    const bad = path.join(base, 'bad-marker');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, '.cr-install'), 'not json');
    const f = makeFake({ appDir });
    expect(await managedInstallProblem(bad, f.deps)).toBe('no-marker');
    expect(f.calls).toEqual([]);
  });

  it('not-git when the git top level is another folder (app nested in some other repo)', async () => {
    const f = makeFake({ appDir, topLevel: 'C:/some/other/repo' });
    expect(await managedInstallProblem(appDir, f.deps)).toBe('not-git');
  });

  it('dirty-tree for tracked changes, for untracked files git does not ignore, and for a failed status', async () => {
    const tracked = makeFake({ appDir, respond: (k) => (k.startsWith('git status') ? { code: 0, stdout: ' M server/src/x.ts\n', stderr: '' } : undefined) });
    expect(await managedInstallProblem(appDir, tracked.deps)).toBe('dirty-tree');
    const untracked = makeFake({ appDir, respond: (k) => (k.startsWith('git ls-files') ? { code: 0, stdout: 'notes.txt\n', stderr: '' } : undefined) });
    expect(await managedInstallProblem(appDir, untracked.deps)).toBe('dirty-tree');
    const failed = makeFake({ appDir, respond: (k) => (k.startsWith('git status') ? { code: 128, stdout: '', stderr: 'fatal' } : undefined) });
    expect(await managedInstallProblem(appDir, failed.deps)).toBe('dirty-tree');
  });

  it('the marker itself and ignored files are not dirt: a clean managed install gives null', async () => {
    const f = makeFake({ appDir, respond: (k) => (k.startsWith('git ls-files') ? { code: 0, stdout: '.cr-install\n', stderr: '' } : undefined) });
    expect(await managedInstallProblem(appDir, f.deps)).toBeNull();
    expect(f.labels()).toEqual(['git rev-parse --show-toplevel', 'git status --porcelain --untracked-files=no', 'git ls-files --others --exclude-standard']);
  });
});

describe('refusals', () => {
  it('dev checkout (no marker): exit 2, the refusal text, and ZERO mutating commands', async () => {
    const bare = path.join(base, 'dev-checkout');
    fs.mkdirSync(bare);
    const f = makeFake({ appDir: bare });
    const code = await runUpdate(opts({ appDir: bare }), f.deps);
    expect(code).toBe(EXIT.REFUSED);
    expect(f.errs).toContain('refused: not a managed install (no .cr-install marker)');
    expect(f.mutating()).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('dirty tree: exit 2, no mutating command', async () => {
    const f = makeFake({ appDir, respond: (k) => (k.startsWith('git status') ? { code: 0, stdout: ' M x\n', stderr: '' } : undefined) });
    expect(await runUpdate(opts(), f.deps)).toBe(EXIT.REFUSED);
    expect(f.errs.some((l) => l.includes('local changes'))).toBe(true);
    expect(f.mutating()).toEqual([]);
  });

  it('a bad tag is rejected before any command runs at all', async () => {
    for (const tag of ['v1.2', 'main', 'v1.2.3-beta', 'v1.2.3; rm -rf x', '../v1.2.3', 'V1.2.3']) {
      const f = makeFake({ appDir });
      expect(await runUpdate(opts({ tag }), f.deps)).toBe(EXIT.REFUSED);
      expect(f.calls).toEqual([]);
      expect(f.errs[0]).toContain('bad tag');
    }
  });

  it('needs exactly one of --tag / --latest', async () => {
    const both = makeFake({ appDir });
    expect(await runUpdate(opts({ latest: true }), both.deps)).toBe(EXIT.REFUSED);
    expect(both.calls).toEqual([]);
    const none = makeFake({ appDir });
    expect(await runUpdate(opts({ tag: undefined }), none.deps)).toBe(EXIT.REFUSED);
    expect(none.calls).toEqual([]);
  });

  it('the user can cancel at the confirmation: exit 2 and no checkout', async () => {
    const f = makeFake({ appDir, alive: [4242], listener: 4242, confirm: false });
    expect(await runUpdate(opts({ pid: 4242 }), f.deps)).toBe(EXIT.REFUSED);
    expect(f.labels()).not.toContain('git checkout --detach v0.2.0');
    expect(f.mutating()).toEqual([]);
  });
});

describe('happy path', () => {
  it('runs the exact command order and writes the new tag to the marker', async () => {
    const f = makeFake({ appDir, alive: [4242], listener: 4242 });
    const code = await runUpdate(opts({ pid: 4242 }), f.deps);
    expect(code).toBe(EXIT.OK);
    expect(f.collapsed()).toEqual([
      'git rev-parse --show-toplevel',
      'git status --porcelain --untracked-files=no',
      'git ls-files --others --exclude-standard',
      'git rev-parse HEAD',
      'git fetch --tags --force origin',
      'git rev-parse --verify refs/tags/v0.2.0^{commit}',
      'taskkill /PID 4242 /T /F',
      'git checkout --detach v0.2.0',
      'npm ci',
      'npm run build',
      'node scripts/lemo-styles.mjs',
      'start-server',
      'GET http://127.0.0.1:8790/',
      'write .cr-install',
    ]);
    expect(readMarkerFile(appDir)).toMatchObject({ tag: 'v0.2.0', installedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-25T10:00:00.000Z' });
    expect(f.out).toContain('done: now on v0.2.0');
    expect(f.errs).toEqual([]);
  });

  it('a pid that is not alive is never killed; the update still goes on', async () => {
    const f = makeFake({ appDir, alive: [], listener: null });
    expect(await runUpdate(opts({ pid: 4242 }), f.deps)).toBe(EXIT.OK);
    expect(f.labels().some((l) => l.startsWith('taskkill'))).toBe(false);
    expect(f.labels()).toContain('start-server');
  });

  it('--latest picks the highest semver tag from ls-remote (v0.10.0, not v0.9.0)', async () => {
    const f = makeFake({ appDir, tagsOnOrigin: ['v0.9.0', 'v0.10.0', 'v0.2.0', 'main'] });
    expect(await runUpdate({ appDir, dataDir, latest: true }, f.deps)).toBe(EXIT.OK);
    expect(f.labels()).toContain('git ls-remote --tags --refs origin');
    expect(f.labels()).toContain('git checkout --detach v0.10.0');
  });

  it('--skills: the skills and plugin steps run after the build and before the start, and their failures are only warnings', async () => {
    const f = makeFake({
      appDir,
      respond: (k) => {
        if (k === 'npx --yes skills update -g -y') return { code: 1, stdout: '', stderr: 'offline' };
        if (k === 'claude plugin update lemo-opuscar@lemolab') return { code: 1, stdout: '', stderr: 'no plugin' };
        return undefined;
      },
    });
    expect(await runUpdate(opts({ skills: true }), f.deps)).toBe(EXIT.OK);
    const seq = f.labels();
    const stepAt = (s: string) => seq.indexOf(s);
    expect(stepAt('npx --yes skills update -g -y')).toBeGreaterThan(stepAt('node scripts/lemo-styles.mjs'));
    expect(stepAt('claude plugin marketplace update')).toBeGreaterThan(stepAt('npx --yes skills update -g -y'));
    expect(stepAt('claude plugin update lemo-opuscar@lemolab')).toBeGreaterThan(stepAt('claude plugin marketplace update'));
    expect(stepAt('start-server')).toBeGreaterThan(stepAt('claude plugin update lemo-opuscar@lemolab'));
    expect(f.errs.filter((l) => l.includes('warning (update continues)')).length).toBe(2);
    expect(f.out).toContain('done: now on v0.2.0');
  });

  it('a failing lemo-styles step is a warning, not a failure', async () => {
    const f = makeFake({ appDir, respond: (k) => (k === 'node scripts/lemo-styles.mjs' ? { code: 1, stdout: '', stderr: 'x' } : undefined) });
    expect(await runUpdate(opts(), f.deps)).toBe(EXIT.OK);
    expect(f.errs.some((l) => l.includes('lemo-styles exited 1'))).toBe(true);
    expect(readMarkerFile(appDir).tag).toBe('v0.2.0');
  });
});

describe('dry run', () => {
  it('prints the plan and runs no mutating command (no fetch, checkout, kill, start, or write)', async () => {
    const f = makeFake({ appDir, alive: [4242], listener: 4242 });
    expect(await runUpdate(opts({ pid: 4242, dryRun: true }), f.deps)).toBe(EXIT.OK);
    expect(f.mutating()).toEqual([]);
    expect(f.calls.some((c) => c.op === 'fetch')).toBe(false);
    expect(f.calls.some((c) => c.op === 'write')).toBe(false);
    expect(f.out.some((l) => l.includes('checkout: git checkout --detach v0.2.0'))).toBe(true);
    expect(f.out).toContain('dry run: nothing was changed');
    expect(readMarkerFile(appDir).tag).toBe('v0.1.0');
  });

  it('dry run with --latest only reads the remote tag list', async () => {
    const f = makeFake({ appDir, tagsOnOrigin: ['v0.3.0'] });
    expect(await runUpdate({ appDir, dataDir, latest: true, dryRun: true }, f.deps)).toBe(EXIT.OK);
    expect(f.mutating()).toEqual([]);
  });
});

describe('failure and rollback', () => {
  it('health check never answers: rollback to the previous commit, restart, marker unchanged, exit 3', async () => {
    const f = makeFake({ appDir, alive: [4242], listener: 4242, health: (n) => (n < 60 ? 'throw' : 200) });
    expect(await runUpdate(opts({ pid: 4242 }), f.deps)).toBe(EXIT.FAILED);
    expect(f.collapsed()).toEqual([
      ...HEAD_CHECKS,
      'git fetch --tags --force origin',
      'git rev-parse --verify refs/tags/v0.2.0^{commit}',
      'taskkill /PID 4242 /T /F',
      'git checkout --detach v0.2.0',
      'npm ci',
      'npm run build',
      'node scripts/lemo-styles.mjs',
      'start-server',
      'GET http://127.0.0.1:8790/',
      'netstat -ano -p TCP',
      'taskkill /PID 5000 /T /F',
      `git checkout --detach ${PREV}`,
      'npm ci',
      'npm run build',
      'start-server',
      'GET http://127.0.0.1:8790/',
    ]);
    expect(f.labels().filter((l) => l.startsWith('write'))).toEqual([]);
    expect(readMarkerFile(appDir)).toMatchObject({ tag: 'v0.1.0' });
    expect(f.out).toContain(`rolled back to ${PREV}; marker unchanged`);
  });

  it('health polls are once per second, 60 tries', async () => {
    const f = makeFake({ appDir, alive: [4242], listener: 4242, health: () => 'throw' });
    expect(await healthCheck(8790, f.deps)).toBe(false);
    expect(f.sleeps).toEqual(Array(59).fill(1000));
    expect(f.calls.filter((c) => c.op === 'fetch')).toHaveLength(60);
  });

  it('rollback that fails: exit 4 with manual-recovery text, and nothing is started', async () => {
    const f = makeFake({
      appDir,
      alive: [4242],
      listener: 4242,
      respond: (k, n) => {
        if (k === 'npm run build' && n === 1) return { code: 1, stdout: '', stderr: 'build broke' };
        if (k === 'npm ci' && n === 2) return { code: 1, stdout: '', stderr: 'registry down' };
        return undefined;
      },
    });
    expect(await runUpdate(opts({ pid: 4242 }), f.deps)).toBe(EXIT.ROLLBACK_FAILED);
    expect(f.collapsed().slice(-4)).toEqual(['npm run build', 'netstat -ano -p TCP', `git checkout --detach ${PREV}`, 'npm ci']);
    expect(f.labels()).not.toContain('start-server');
    expect(f.errs.some((l) => l.includes('ROLLBACK FAILED'))).toBe(true);
    expect(f.errs.some((l) => l.includes('manual recovery'))).toBe(true);
    expect(readMarkerFile(appDir).tag).toBe('v0.1.0');
  });

  it('a failure before checkout changes nothing: exit 3 with no rollback', async () => {
    const f = makeFake({ appDir, respond: (k) => (k === 'git fetch --tags --force origin' ? { code: 1, stdout: '', stderr: 'unreachable' } : undefined) });
    expect(await runUpdate(opts(), f.deps)).toBe(EXIT.FAILED);
    expect(f.labels()).not.toContain('git checkout --detach v0.2.0');
    expect(f.labels().some((l) => l.startsWith(`git checkout --detach ${PREV}`))).toBe(false);
    expect(f.labels()).not.toContain('start-server');
    expect(f.errs).toContain('no files were changed');
  });

  it('a failure after stop-server but before checkout restarts the server on the unchanged code (exit 3, no rollback)', async () => {
    const f = makeFake({ appDir, alive: [4242], listener: 4242 });
    // taskkill returns, but the pid is still alive: killAndConfirm throws after the stop was attempted.
    f.deps.killTree = async (pid: number) => {
      f.calls.push({ op: 'run', cmd: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] });
    };
    expect(await runUpdate(opts({ pid: 4242 }), f.deps)).toBe(EXIT.FAILED);
    const seq = f.collapsed();
    expect(seq).toContain('taskkill /PID 4242 /T /F');
    expect(seq.some((l) => l.startsWith('git checkout'))).toBe(false);
    expect(seq.indexOf('start-server')).toBeGreaterThan(seq.indexOf('taskkill /PID 4242 /T /F'));
    expect(seq[seq.length - 1]).toBe('GET http://127.0.0.1:8790/');
    expect(f.errs).toContain('no files were changed');
    expect(f.errs.some((l) => l.includes('restarting the server on the unchanged code'))).toBe(true);
    expect(f.errs).toContain('server restarted on the previous code');
    expect(readMarkerFile(appDir).tag).toBe('v0.1.0');
  });

  it('a stop that cannot read the port (netstat fails) before checkout also restarts the server', async () => {
    const f = makeFake({
      appDir,
      alive: [],
      listener: null,
      respond: (k) => (k === 'netstat -ano -p TCP' ? { code: 1, stdout: '', stderr: 'denied' } : undefined),
    });
    expect(await runUpdate(opts(), f.deps)).toBe(EXIT.FAILED);
    expect(f.labels()).not.toContain('git checkout --detach v0.2.0');
    expect(f.labels()).toContain('start-server');
    expect(f.labels()).toContain('GET http://127.0.0.1:8790/');
    expect(f.errs.some((l) => l.includes('netstat failed'))).toBe(true);
  });

  it('a tag missing on origin fails before checkout (exit 3)', async () => {
    const f = makeFake({ appDir, respond: (k) => (k.startsWith('git rev-parse --verify') ? { code: 128, stdout: '', stderr: 'bad revision' } : undefined) });
    expect(await runUpdate(opts(), f.deps)).toBe(EXIT.FAILED);
    expect(f.labels()).not.toContain('git checkout --detach v0.2.0');
  });
});

describe('stopping the server', () => {
  it('with --pid, only that exact pid is killed, even when another process listens on the port', async () => {
    const f = makeFake({ appDir, alive: [4242], listener: 9999 });
    expect(await runUpdate(opts({ pid: 4242 }), f.deps)).toBe(EXIT.OK);
    const kills = f.calls.filter((c) => c.op === 'run' && c.cmd === 'taskkill');
    expect(kills).toEqual([{ op: 'run', cmd: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }]);
    expect(f.labels()).not.toContain('netstat -ano -p TCP');
  });

  it('without --pid, the single listener of the port is killed by its pid (never by name)', async () => {
    const f = makeFake({ appDir, alive: [9999], listener: 9999 });
    expect(await runUpdate(opts(), f.deps)).toBe(EXIT.OK);
    expect(f.labels()).toContain('taskkill /PID 9999 /T /F');
    expect(f.calls.filter((c) => c.op === 'run' && c.cmd === 'taskkill').every((c) => c.op === 'run' && c.args[0] === '/PID')).toBe(true);
  });

  it('never kills the updater itself: a --pid equal to its own pid is refused before any command', async () => {
    const f = makeFake({ appDir, alive: [7777], selfPid: 7777 });
    expect(await runUpdate(opts({ pid: 7777 }), f.deps)).toBe(EXIT.REFUSED);
    expect(f.calls).toEqual([]);
    expect(f.errs).toContain('refused: --pid is the updater itself');
  });
});

describe('log file', () => {
  it('appends timestamped lines to <dataDir>/update.log, redacts credentials, and never dumps the environment', async () => {
    const f = makeFake({
      appDir,
      respond: (k) =>
        k === 'git fetch --tags --force origin'
          ? { code: 128, stdout: '', stderr: 'fatal: unable to access https://builder:hunter2secret@example.com/x/y.git' }
          : undefined,
    });
    expect(await runUpdate(opts(), f.deps)).toBe(EXIT.FAILED);
    const logText = fs.readFileSync(path.join(dataDir, 'update.log'), 'utf8');
    expect(logText).not.toContain('hunter2secret');
    expect(logText).toContain('https://***@example.com/x/y.git');
    expect(logText).toMatch(/^\[2026-11-25T10:00:00\.000Z\] /m);
    expect(logText).not.toMatch(/PATH=|APPDATA=|USERPROFILE=/);
    expect(f.out.join('\n')).not.toContain('hunter2secret');
    expect(f.errs.join('\n')).not.toContain('hunter2secret');
  });

  it('redact hides URL credentials, token pairs and GitHub tokens', () => {
    expect(redact('https://user:pw@host/x')).toBe('https://***@host/x');
    expect(redact('token=abc123 ok')).toBe('token=*** ok');
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz1234')).toBe('***');
  });
});

describe('pid in the plan', () => {
  it('planUpdate lists the stop as an exact pid when one is given', () => {
    const steps = planUpdate({ appDir, tag: 'v0.2.0', pid: 4242 });
    const stop = steps.find((s) => s.kind === 'stop');
    expect(stop).toMatchObject({ kind: 'stop', pid: 4242, port: 8790, fallbackToPort: false, mandatory: true });
    expect(describeStep(stop!)).toContain('taskkill pid 4242');
  });
});

describe('pure helpers', () => {
  it('planUpdate order without skills; skills steps sit before the stop and are warning-only', () => {
    const ids = planUpdate({ appDir, tag: 'v0.2.0' }).map((s) => s.id);
    expect(ids).toEqual([
      'check',
      'record-prev',
      'fetch',
      'verify-tag',
      'stop-server',
      'checkout',
      'npm-ci',
      'build',
      'lemo-styles',
      'start-server',
      'health',
      'write-marker',
    ]);
    const withSkills = planUpdate({ appDir, tag: 'v0.2.0', withSkills: true });
    const skill = withSkills.filter((s) => s.id.startsWith('skills') || s.id.startsWith('plugin'));
    expect(skill).toHaveLength(3);
    expect(skill.every((s) => s.kind === 'cmd' && s.mandatory === false)).toBe(true);
    const at = (id: string) => withSkills.findIndex((s) => s.id === id);
    expect(at('stop-server')).toBeLessThan(at('checkout'));
    expect(at('skills-update')).toBeGreaterThan(at('lemo-styles'));
    expect(at('plugin-lemo')).toBeLessThan(at('start-server'));
  });

  it('planUpdate refuses a bad tag and planRollback goes stop, checkout, deps, build, start, health', () => {
    expect(() => planUpdate({ appDir, tag: 'latest' })).toThrow();
    expect(planRollback({ appDir, prevRef: PREV, port: 8790 }).map((s) => s.id)).toEqual([
      'stop-server',
      'checkout',
      'npm-ci',
      'build',
      'start-server',
      'health',
    ]);
  });

  it('latestTag picks the highest vX.Y.Z by number, ignoring other names', () => {
    expect(latestTag(['v0.9.0', 'v0.10.0', 'main', 'v1.0.0-rc1', 'v0.10.0^{}'])).toBe('v0.10.0');
    expect(latestTag(['main'])).toBeNull();
  });

  it('parseLsRemoteTags reads tag names; parseNetstatPids reads only LISTENING pids on the port', () => {
    expect(parseLsRemoteTags(`${TAG_SHA}\trefs/tags/v0.2.0\nabc\trefs/tags/main\n`)).toEqual(['v0.2.0', 'main']);
    const netstat = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:8790           0.0.0.0:0              LISTENING       4242',
      '  TCP    [::]:8790              [::]:0                 LISTENING       4242',
      '  TCP    127.0.0.1:8790         127.0.0.1:55000        ESTABLISHED     3003',
      '  TCP    0.0.0.0:8791           0.0.0.0:0              LISTENING       5555',
    ].join('\n');
    expect(parseNetstatPids(netstat, 8790)).toEqual([4242]);
    expect(parseNetstatPids(netstat, 9999)).toEqual([]);
  });

  it('parseUpdateArgs: accepts the documented flags and refuses bad input', () => {
    expect(parseUpdateArgs(['--tag', 'v0.2.0', '--pid', '4242', '--port=8790', '--skills', '--dry-run', '--data-dir', 'D:/d'])).toEqual({
      ok: true,
      opts: { app: null, tag: 'v0.2.0', latest: false, pid: 4242, port: 8790, dataDir: 'D:/d', skills: true, dryRun: true, yes: false },
    });
    expect(parseUpdateArgs(['--latest', '--yes'])).toMatchObject({ ok: true, opts: { latest: true, yes: true } });
    expect(parseUpdateArgs([])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(['--tag', 'v1.2'])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(['--latest', '--tag', 'v1.0.0'])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(['--latest', '--pid', 'abc'])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(['--latest', '--port', '70000'])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(['--latest', '--dry-run=yes'])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(['--latest', '--frob'])).toMatchObject({ ok: false });
    expect(parseUpdateArgs(['--tag'])).toMatchObject({ ok: false });
  });
});

/** Runs fn with process.platform faked (restored afterwards). The launch shape depends on it, nothing else does. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    if (real) Object.defineProperty(process, 'platform', real);
  }
}

describe('spawnUpdaterDetached', () => {
  it('off win32 it spawns node on scripts/update.mjs directly, detached, hidden, stdio ignored, then unrefs; returns ok', () => {
    const spawned: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
    let unrefs = 0;
    const r = withPlatform('linux', () =>
      spawnUpdaterDetached(
        { appDir, tag: 'v0.2.0', pid: 4242, port: 8790, dataDir, skills: true },
        (cmd, args, o) => {
          spawned.push({ cmd, args, opts: o });
          return { unref: () => unrefs++ };
        },
      ),
    );
    expect(r).toEqual({ ok: true });
    expect(spawned).toEqual([
      {
        cmd: process.execPath,
        args: [path.join(appDir, 'scripts', 'update.mjs'), '--app', appDir, '--tag', 'v0.2.0', '--yes', '--pid', '4242', '--port', '8790', '--data-dir', dataDir, '--skills'],
        opts: { detached: true, stdio: 'ignore', windowsHide: true },
      },
    ]);
    expect(unrefs).toBe(1);
  });

  it('on win32 the updater goes through cmd start, so its parent is not the server (taskkill /T of the server cannot reach it)', () => {
    const app = path.join(base, 'my app');
    const spawned: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
    let unrefs = 0;
    const r = withPlatform('win32', () =>
      spawnUpdaterDetached(
        { appDir: app, tag: 'v0.2.0', pid: 4242, port: 8790, dataDir: path.join(base, 'data dir'), skills: false },
        (cmd, args, o) => {
          spawned.push({ cmd, args, opts: o as unknown as Record<string, unknown> });
          return { unref: () => unrefs++ };
        },
      ),
    );
    expect(r).toEqual({ ok: true });
    expect(spawned).toHaveLength(1);
    const [call] = spawned;
    expect(call.cmd).toBe('cmd.exe');
    expect(call.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // Outer quotes for cmd /s, an empty title for start, then every token quoted (paths with spaces survive).
    const line = call.args[3];
    expect(line.startsWith('"start "" /b "')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
    const tokens = [
      process.execPath,
      path.join(app, 'scripts', 'update.mjs'),
      '--app',
      app,
      '--tag',
      'v0.2.0',
      '--yes',
      '--pid',
      '4242',
      '--port',
      '8790',
      '--data-dir',
      path.join(base, 'data dir'),
    ];
    expect(line.slice(1, -1)).toBe(`start "" /b ${tokens.map((t) => `"${t}"`).join(' ')}`);
    expect(call.opts).toEqual({ detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    expect(unrefs).toBe(1);
  });

  it('on win32 a path with a quote, % or ! is refused without spawning (cmd quoting cannot carry it safely)', () => {
    let spawns = 0;
    const spawnFn = () => {
      spawns++;
      return { unref: () => undefined };
    };
    withPlatform('win32', () => {
      expect(spawnUpdaterDetached({ appDir, tag: 'v0.2.0', dataDir: path.join(base, 'a%PATH%b') }, spawnFn)).toMatchObject({ ok: false });
      expect(spawnUpdaterDetached({ appDir, tag: 'v0.2.0', dataDir: path.join(base, 'a"b') }, spawnFn)).toMatchObject({ ok: false });
      expect(spawnUpdaterDetached({ appDir, tag: 'v0.2.0', dataDir: path.join(base, 'a!b') }, spawnFn)).toMatchObject({ ok: false });
    });
    expect(spawns).toBe(0);
  });

  it('a bad tag, pid or port is refused without spawning; a spawn error is returned, not thrown', () => {
    let spawns = 0;
    const spawnFn = () => {
      spawns++;
      return { unref: () => undefined };
    };
    expect(spawnUpdaterDetached({ appDir, tag: 'main' }, spawnFn)).toMatchObject({ ok: false });
    expect(spawnUpdaterDetached({ appDir, tag: 'v0.2.0', pid: -1 }, spawnFn)).toMatchObject({ ok: false });
    expect(spawns).toBe(0);
    const r = spawnUpdaterDetached({ appDir, tag: 'v0.2.0' }, () => {
      throw new Error('spawn EPERM https://u:pw@x');
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).not.toContain('pw@');
  });
});
