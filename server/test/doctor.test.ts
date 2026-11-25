// Environment doctor: every check's ok/warn/fail path with fake deps, parallel isolation, report.ok, secrets
// never in output, and DoctorApi over a real loopback http server. Nothing touches the real ~/.claude, the
// real data dir, or port 8790: all paths are fakes or a temp dir, and exec is always faked.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromeCandidates, printReport, runDoctor, versionAtLeast, type DoctorDeps, type DoctorReport } from '../src/doctor';
import { DoctorApi } from '../src/doctorApi';

const CLAUDE = path.join('fake-root', 'claude-dir');
const HOME = path.join('fake-root', 'home');
const LEMO = path.join('fake-root', 'lemo-styles.json');
const P = (...parts: string[]) => path.join(...parts);

let tmp = '';
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Exec = DoctorDeps['exec'];

interface Fake {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  exec?: Exec;
  env?: Record<string, string | undefined>;
  nodeVersion?: string;
  platform?: string;
  dataDir?: string;
  eleven?: boolean | (() => Promise<boolean>);
}

/** Every dep is a fake. `exec` answers `<cmd> version 1.2.3` (exit 0) unless the test overrides it. */
function fakeDeps(o: Fake = {}): Partial<DoctorDeps> {
  const files = new Map(Object.entries(o.files ?? {}));
  const dirs = o.dirs ?? {};
  const eleven = o.eleven ?? false;
  return {
    exec: o.exec ?? (async (cmd) => ({ code: 0, stdout: `${cmd} version 1.2.3\nsecond line` })),
    env: o.env ?? {},
    claudeDir: CLAUDE,
    home: HOME,
    dataDir: o.dataDir ?? P(tmp, 'data'),
    fileExists: async (p) => files.has(p),
    readText: async (p) => files.get(p) ?? null,
    listDir: async (p) => (dirs[p] ?? []).map((name) => ({ name, isDirectory: true })),
    hasElevenKey: typeof eleven === 'function' ? eleven : async () => eleven,
    lemoFile: LEMO,
    platform: o.platform ?? 'win32',
    nodeVersion: o.nodeVersion ?? '22.18.0',
  };
}

/** Everything present and healthy. */
function healthyFiles(): Record<string, string> {
  return {
    [P(CLAUDE, '.credentials.json')]: '{"token":"x"}',
    [P(CLAUDE, 'skills', 'hyperframes', 'SKILL.md')]: '# hf',
    [P(CLAUDE, 'plugins', 'installed_plugins.json')]: JSON.stringify({ plugins: { 'lemo-opuscar@lemolab': [{}] } }),
    [LEMO]: JSON.stringify([{ id: 'a', name: 'A', category: 'c', stylePath: 's', thumb: null }]),
    [P(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')]: '',
  };
}

function healthyEnv(): Record<string, string | undefined> {
  return { ProgramFiles: 'PF', LOCALAPPDATA: 'LAD' };
}

function healthy(extra: Fake = {}): Partial<DoctorDeps> {
  const env = { ...healthyEnv(), ...(extra.env ?? {}) };
  const files = {
    [P(CLAUDE, '.credentials.json')]: '{}',
    [P(CLAUDE, 'skills', 'hyperframes', 'SKILL.md')]: '# hf',
    [P(CLAUDE, 'plugins', 'installed_plugins.json')]: JSON.stringify({ plugins: { 'lemo-opuscar@lemolab': [{}] } }),
    [LEMO]: JSON.stringify([{ id: 'a', name: 'A', category: 'c', stylePath: 's', thumb: null }]),
    [P('PF', 'Google', 'Chrome', 'Application', 'chrome.exe')]: '',
    ...(extra.files ?? {}),
  };
  return fakeDeps({ eleven: true, ...extra, env, files });
}

async function run(deps: Partial<DoctorDeps>) {
  const report = await runDoctor(deps);
  const get = (id: string) => {
    const c = report.checks.find((x) => x.id === id);
    if (!c) throw new Error(`no check ${id}`);
    return c;
  };
  return { report, get };
}

const ALL_IDS = [
  'node',
  'git',
  'claude',
  'claudeLogin',
  'chrome',
  'ffmpeg',
  'ffprobe',
  'hyperframesSkills',
  'lemoPlugin',
  'lemoStyles',
  'elevenKey',
  'dataDir',
];

describe('versionAtLeast', () => {
  it('compares dotted versions numerically', () => {
    expect(versionAtLeast('22.18.0', '22.18.0')).toBe(true);
    expect(versionAtLeast('22.17.9', '22.18.0')).toBe(false);
    expect(versionAtLeast('23.0.0', '22.18.0')).toBe(true);
    expect(versionAtLeast('v22.18.1', '22.18.0')).toBe(true);
    expect(versionAtLeast('22.9.0', '22.18.0')).toBe(false);
    expect(versionAtLeast('20.19.0', '22.18.0')).toBe(false);
  });
});

describe('runDoctor: check ids and healthy baseline', () => {
  it('returns every check in the fixed order and ok=true when nothing fails', async () => {
    const { report } = await run(healthy());
    expect(report.checks.map((c) => c.id)).toEqual(ALL_IDS);
    expect(report.checks.every((c) => c.status === 'ok')).toBe(true);
    expect(report.ok).toBe(true);
    expect(typeof report.checkedAt).toBe('number');
  });
});

describe('node', () => {
  it('ok at exactly 22.18.0 and above', async () => {
    const { get } = await run(healthy({ nodeVersion: '22.18.0' }));
    expect(get('node')).toMatchObject({ status: 'ok', detail: 'v22.18.0' });
  });
  it('fails below 22.18 with the winget fix', async () => {
    const { get } = await run(healthy({ nodeVersion: '22.17.9' }));
    expect(get('node').status).toBe('fail');
    expect(get('node').detail).toContain('need >= 22.18.0');
    expect(get('node').fix).toBe('winget install OpenJS.NodeJS.LTS');
  });
});

describe('git', () => {
  it('ok with the first line of git --version', async () => {
    const { get } = await run(healthy({ exec: async (cmd) => ({ code: 0, stdout: 'git version 2.54.0\n' }) }));
    expect(get('git')).toMatchObject({ status: 'ok', detail: 'git version 2.54.0' });
  });
  it('warns when git is missing', async () => {
    const { get } = await run(healthy({ exec: async (cmd) => ({ code: cmd === 'git' ? null : 0, stdout: '' }) }));
    expect(get('git')).toMatchObject({ status: 'warn', fix: 'winget install Git.Git' });
  });
});

describe('claude', () => {
  it('ok, and honours CR_CLAUDE_BIN', async () => {
    const calls: string[] = [];
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: '1.0.99 (Claude Code)\n' };
    };
    const { get } = await run(healthy({ exec, env: { CR_CLAUDE_BIN: 'D:/bin/claude.exe' } }));
    expect(calls).toContain('D:/bin/claude.exe');
    expect(get('claude')).toMatchObject({ status: 'ok', detail: '1.0.99 (Claude Code)' });
  });
  it('fails when claude is missing, with the install fix', async () => {
    const { get, report } = await run(healthy({ exec: async (cmd) => ({ code: cmd === 'claude' ? null : 0, stdout: '' }) }));
    expect(get('claude')).toMatchObject({ status: 'fail', detail: 'claude not found', fix: 'irm https://claude.ai/install.ps1 | iex' });
    expect(report.ok).toBe(false);
  });
});

describe('claudeLogin', () => {
  it('ok when .credentials.json exists', async () => {
    const { get } = await run(healthy({ files: { [P(CLAUDE, '.credentials.json')]: '{}' } }));
    expect(get('claudeLogin').status).toBe('ok');
  });
  it('ok when ~/.claude.json has the oauthAccount key (no credentials file)', async () => {
    const { get } = await run({
      ...healthy(),
      fileExists: async () => false,
      readText: async (p) => (p === P(HOME, '.claude.json') ? JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com' } }) : null),
    });
    expect(get('claudeLogin')).toMatchObject({ status: 'ok', detail: 'account present in .claude.json' });
  });
  it('warns with the sign-in fix when nothing is present', async () => {
    const { get } = await run({ ...healthy(), fileExists: async () => false, readText: async () => null });
    expect(get('claudeLogin')).toMatchObject({ status: 'warn', fix: 'run: claude   (then sign in)' });
  });
  it('warns when ~/.claude.json has no oauthAccount key', async () => {
    const { get } = await run({
      ...healthy(),
      fileExists: async () => false,
      readText: async (p) => (p === P(HOME, '.claude.json') ? JSON.stringify({ numStartups: 3 }) : null),
    });
    expect(get('claudeLogin').status).toBe('warn');
  });
  it('warns (does not throw) when ~/.claude.json is corrupt', async () => {
    const { get, report } = await run({
      ...healthy(),
      fileExists: async () => false,
      readText: async (p) => (p === P(HOME, '.claude.json') ? '{not json' : null),
    });
    expect(get('claudeLogin').status).toBe('warn');
    expect(report.checks).toHaveLength(ALL_IDS.length);
  });
});

describe('chrome', () => {
  it('chromeCandidates lists Program Files, Program Files (x86) and LocalAppData installs', () => {
    const c = chromeCandidates({ ProgramFiles: 'PF', 'ProgramFiles(x86)': 'PF86', LOCALAPPDATA: 'LAD' });
    expect(c).toEqual([
      P('PF', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      P('PF86', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      P('LAD', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  });
  it('ok when Chrome is found under the per-user LocalAppData install', async () => {
    const lad = P('LAD', 'Google', 'Chrome', 'Application', 'chrome.exe');
    const { get } = await run({ ...healthy(), env: { LOCALAPPDATA: 'LAD' }, fileExists: async (p) => p === lad });
    expect(get('chrome')).toMatchObject({ status: 'ok', detail: 'chrome found' });
  });
  it('warns with the install fix when Chrome is not found', async () => {
    const { get } = await run({ ...healthy(), fileExists: async () => false });
    expect(get('chrome')).toMatchObject({ status: 'warn', fix: 'Install Chrome and the Claude in Chrome extension' });
  });
  it('warns off Windows without probing paths', async () => {
    const { get } = await run({ ...healthy(), platform: 'linux', fileExists: async () => true });
    expect(get('chrome').status).toBe('warn');
  });
});

describe('ffmpeg and ffprobe', () => {
  it('ok with the first line of -version', async () => {
    const { get } = await run(healthy({ exec: async (cmd) => ({ code: 0, stdout: `${cmd} version 7.1 built\nx` }) }));
    expect(get('ffmpeg')).toMatchObject({ status: 'ok', detail: 'ffmpeg version 7.1 built' });
    expect(get('ffprobe')).toMatchObject({ status: 'ok', detail: 'ffprobe version 7.1 built' });
  });
  it('fails when either binary is missing, with the Gyan.FFmpeg fix', async () => {
    const { get, report } = await run(healthy({ exec: async (cmd) => ({ code: cmd === 'ffprobe' ? null : 0, stdout: 'v' }) }));
    expect(get('ffprobe')).toMatchObject({ status: 'fail', fix: 'winget install Gyan.FFmpeg' });
    expect(get('ffmpeg').status).toBe('ok');
    expect(report.ok).toBe(false);
  });
});

describe('hyperframesSkills', () => {
  it('ok when the skill is under claudeDir/skills', async () => {
    const { get } = await run(healthy());
    expect(get('hyperframesSkills').status).toBe('ok');
  });
  it('ok when the skill is under ~/.agents/skills', async () => {
    const { get } = await run({
      ...healthy(),
      fileExists: async (p) => p === P(HOME, '.agents', 'skills', 'hyperframes', 'SKILL.md'),
    });
    expect(get('hyperframesSkills').status).toBe('ok');
  });
  it('warns with the skills add fix when absent', async () => {
    const { get } = await run({ ...healthy(), fileExists: async () => false });
    expect(get('hyperframesSkills')).toMatchObject({ status: 'warn', fix: 'npx --yes skills add heygen-com/hyperframes -g -y' });
  });
});

describe('lemoPlugin', () => {
  it('ok when installed_plugins.json has a lemo-opuscar@ key', async () => {
    const { get } = await run(healthy());
    expect(get('lemoPlugin')).toMatchObject({ status: 'ok', detail: 'lemo-opuscar@lemolab' });
  });
  it('ok from a marketplace folder whose name contains lemo', async () => {
    const { get } = await run({
      ...healthy({ files: {} }),
      fileExists: async () => false,
      readText: async () => null,
      listDir: async (p) => (p === P(CLAUDE, 'plugins', 'marketplaces') ? [{ name: 'lemolab', isDirectory: true }] : []),
    });
    expect(get('lemoPlugin')).toMatchObject({ status: 'ok', detail: 'marketplace lemolab' });
  });
  it('warns with the marketplace and install fix when there is no lemo entry', async () => {
    const { get } = await run({
      ...healthy(),
      readText: async () => JSON.stringify({ plugins: { 'other@x': [] } }),
      listDir: async () => [],
    });
    expect(get('lemoPlugin')).toMatchObject({
      status: 'warn',
      fix: 'claude plugin marketplace add lemomo-ai/lemo-opuscar then claude plugin install lemo-opuscar@lemolab',
    });
  });
  it('a corrupt installed_plugins.json is a warn, not a crash, and the marketplace folder still counts', async () => {
    const corrupt = await run({
      ...healthy(),
      readText: async () => '{"plugins": ',
      listDir: async () => [],
    });
    expect(corrupt.get('lemoPlugin').status).toBe('warn');
    expect(corrupt.get('lemoPlugin').detail).toContain('unreadable');

    const withFolder = await run({
      ...healthy(),
      readText: async () => '{"plugins": ',
      listDir: async () => [{ name: 'lemo-opuscar', isDirectory: true }],
    });
    expect(withFolder.get('lemoPlugin').status).toBe('ok');
  });
});

describe('lemoStyles', () => {
  it('ok with the style count', async () => {
    const { get } = await run(healthy());
    expect(get('lemoStyles')).toMatchObject({ status: 'ok', detail: '1 styles' });
  });
  it('warns with the install fix when the file is missing', async () => {
    const { get } = await run({ ...healthy(), readText: async () => null });
    expect(get('lemoStyles')).toMatchObject({ status: 'warn', detail: 'not installed', fix: 'node scripts/lemo-styles.mjs' });
  });
  it('warns with the parse error when the file is corrupt', async () => {
    const { get } = await run({ ...healthy(), readText: async (p) => (p === LEMO ? '[{' : null) });
    expect(get('lemoStyles').status).toBe('warn');
    expect(get('lemoStyles').detail).toContain('lemo-styles.json');
  });
  it('warns when the file has no usable styles', async () => {
    const { get } = await run({ ...healthy(), readText: async (p) => (p === LEMO ? '[]' : null) });
    expect(get('lemoStyles')).toMatchObject({ status: 'warn', detail: 'no styles in file' });
  });
});

describe('elevenKey', () => {
  it('ok when a key is set (presence only)', async () => {
    const { get } = await run(healthy({ eleven: true }));
    expect(get('elevenKey')).toEqual({ id: 'elevenKey', status: 'ok', detail: 'set' });
  });
  it('warns "not set" with the settings hint when absent', async () => {
    const { get } = await run(healthy({ eleven: false }));
    expect(get('elevenKey')).toEqual({ id: 'elevenKey', status: 'warn', detail: 'not set', fix: 'Settings -> ElevenLabs key' });
  });
});

describe('dataDir', () => {
  it('ok when the directory is created and writable', async () => {
    const dir = P(tmp, 'fresh', 'nested');
    const { get } = await run(healthy({ dataDir: dir }));
    expect(get('dataDir')).toMatchObject({ status: 'ok', detail: dir });
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.doctor-'))).toEqual([]);
  });
  it('fails when the directory cannot be created', async () => {
    const blocker = P(tmp, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const { get, report } = await run(healthy({ dataDir: P(blocker, 'sub') }));
    expect(get('dataDir').status).toBe('fail');
    expect(get('dataDir').detail).toContain('check error');
    expect(report.ok).toBe(false);
  });
});

describe('ffmpeg / claude report.ok semantics', () => {
  it('a warn-only report is still ok', async () => {
    const { report } = await run({ ...healthy({ eleven: false }), fileExists: async () => false, readText: async () => null, listDir: async () => [] });
    expect(report.checks.some((c) => c.status === 'warn')).toBe(true);
    expect(report.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(report.ok).toBe(true);
  });
  it('any fail makes ok=false', async () => {
    const { report } = await run({ ...healthy(), nodeVersion: '20.0.0' });
    expect(report.checks.find((c) => c.id === 'node')?.status).toBe('fail');
    expect(report.ok).toBe(false);
  });
});

describe('parallel isolation', () => {
  it('a throwing exec does not stop the other checks', async () => {
    const exec: Exec = async (cmd) => {
      if (cmd === 'claude') throw new Error('boom from exec');
      return { code: 0, stdout: `${cmd} 1.0` };
    };
    const { report, get } = await run({ ...healthy(), exec });
    expect(report.checks.map((c) => c.id)).toEqual(ALL_IDS);
    expect(get('claude')).toMatchObject({ status: 'fail', detail: 'check error: boom from exec' });
    expect(get('git').status).toBe('ok');
    expect(get('lemoStyles').status).toBe('ok');
    expect(get('dataDir').status).toBe('ok');
  });

  it('a throwing dep in a warn-level check becomes warn, and the rest stay ok', async () => {
    const { report, get } = await run({
      ...healthy(),
      readText: async () => null,
      listDir: async () => {
        throw new Error('listDir broke');
      },
      fileExists: async (p) => p === P(CLAUDE, '.credentials.json'),
    });
    expect(get('lemoPlugin')).toMatchObject({ status: 'warn', detail: 'check error: listDir broke' });
    expect(get('claudeLogin').status).toBe('ok');
    expect(report.checks).toHaveLength(ALL_IDS.length);
  });

  it('a throwing hasElevenKey is a warn for elevenKey only', async () => {
    const { get } = await run({
      ...healthy(),
      hasElevenKey: async () => {
        throw new Error('vault locked');
      },
    });
    expect(get('elevenKey')).toMatchObject({ status: 'warn', detail: 'check error: vault locked' });
    expect(get('node').status).toBe('ok');
  });
});

describe('secrets never reach the report', () => {
  it('oauthAccount values from ~/.claude.json are not in the JSON', async () => {
    const email = 'secret.person@example.com';
    const token = 'sk-ant-SECRET-VALUE-123';
    const { report } = await run({
      ...healthy({ files: {} }),
      fileExists: async () => false,
      readText: async (p) =>
        p === P(HOME, '.claude.json') ? JSON.stringify({ oauthAccount: { emailAddress: email, accessToken: token } }) : null,
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain(email);
    expect(json).not.toContain(token);
    expect(report.checks.find((c) => c.id === 'claudeLogin')?.status).toBe('ok');
  });
});

describe('printReport', () => {
  const report: DoctorReport = {
    ok: false,
    checkedAt: 1,
    checks: [
      { id: 'node', status: 'ok', detail: 'v22.18.0' },
      { id: 'claude', status: 'fail', detail: 'claude not found', fix: 'irm https://claude.ai/install.ps1 | iex' },
      { id: 'chrome', status: 'warn', detail: 'chrome not found', fix: 'Install Chrome and the Claude in Chrome extension' },
    ],
  };
  it('prints one line per check with a fix line for non-ok checks and returns 1 on fail', () => {
    const lines: string[] = [];
    const code = printReport(report, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines).toEqual([
      '[ OK ] node - v22.18.0',
      '[FAIL] claude - claude not found',
      '   fix: irm https://claude.ai/install.ps1 | iex',
      '[WARN] chrome - chrome not found',
      '   fix: Install Chrome and the Claude in Chrome extension',
    ]);
  });
  it('returns 0 when nothing failed', () => {
    const lines: string[] = [];
    expect(printReport({ ...report, ok: true, checks: [report.checks[0]!] }, (l) => lines.push(l))).toBe(0);
  });
});

// ---- DoctorApi over a real loopback server (port 0) ----

const ALLOWED = 'http://127.0.0.1:5173';

function fakeReport(): DoctorReport {
  return { ok: true, checkedAt: Date.now(), checks: [{ id: 'node', status: 'ok', detail: 'v22.18.0' }] };
}

interface Got {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, method: string, urlPath: string, origin?: string): Promise<Got> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (origin) headers.Origin = origin;
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function listen(api: DoctorApi): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (api.handle(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

describe('DoctorApi', () => {
  const originAllowed = (o: string | undefined) => o === ALLOWED;
  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it('GET /api/doctor returns the report JSON with no-store and echoes an allowed origin', async () => {
    const api = new DoctorApi({ originAllowed, run: async () => fakeReport() });
    const l = await listen(api);
    server = l.server;
    const r = await request(l.port, 'GET', '/api/doctor', ALLOWED);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('application/json');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['access-control-allow-origin']).toBe(ALLOWED);
    const body = JSON.parse(r.body) as DoctorReport;
    expect(body.ok).toBe(true);
    expect(body.checks[0]).toEqual({ id: 'node', status: 'ok', detail: 'v22.18.0' });
    expect(typeof body.checkedAt).toBe('number');
  });

  it('a foreign origin gets 403', async () => {
    const api = new DoctorApi({ originAllowed, run: async () => fakeReport() });
    const l = await listen(api);
    server = l.server;
    const r = await request(l.port, 'GET', '/api/doctor', 'https://evil.example');
    expect(r.status).toBe(403);
    expect(r.body).toBe('');
  });

  it('unknown paths are not handled (the caller falls through)', async () => {
    const api = new DoctorApi({ originAllowed, run: async () => fakeReport() });
    const l = await listen(api);
    server = l.server;
    const r = await request(l.port, 'GET', '/api/other', ALLOWED);
    expect(r.status).toBe(404);
  });

  it('caches for 5 s: sequential GETs share one run, and an expired cache runs again', async () => {
    let calls = 0;
    const api = new DoctorApi({
      originAllowed,
      run: async () => {
        calls++;
        return fakeReport();
      },
    });
    const l = await listen(api);
    server = l.server;
    await request(l.port, 'GET', '/api/doctor', ALLOWED);
    await request(l.port, 'GET', '/api/doctor', ALLOWED);
    await request(l.port, 'GET', '/api/doctor', ALLOWED);
    expect(calls).toBe(1);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
    await request(l.port, 'GET', '/api/doctor', ALLOWED);
    expect(calls).toBe(2);
  });

  it('concurrent GETs share one in-flight run', async () => {
    let calls = 0;
    const api = new DoctorApi({
      originAllowed,
      run: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 60));
        return fakeReport();
      },
    });
    const l = await listen(api);
    server = l.server;
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => request(l.port, 'GET', '/api/doctor', ALLOWED)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(calls).toBe(1);
  });

  it('POST /api/doctor/refresh forces a new run even inside the cache window', async () => {
    let calls = 0;
    const api = new DoctorApi({
      originAllowed,
      run: async () => {
        calls++;
        return fakeReport();
      },
    });
    const l = await listen(api);
    server = l.server;
    await request(l.port, 'GET', '/api/doctor', ALLOWED);
    expect(calls).toBe(1);
    const r = await request(l.port, 'POST', '/api/doctor/refresh', ALLOWED);
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
    await request(l.port, 'GET', '/api/doctor', ALLOWED);
    expect(calls).toBe(2);
  });

  it('a failing run answers 500 with a generic error', async () => {
    const api = new DoctorApi({
      originAllowed,
      run: async () => {
        throw new Error('internal detail');
      },
    });
    const l = await listen(api);
    server = l.server;
    const r = await request(l.port, 'GET', '/api/doctor', ALLOWED);
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: 'server error' });
  });

  it('OPTIONS answers 204 with the CORS allow headers', async () => {
    const api = new DoctorApi({ originAllowed, run: async () => fakeReport() });
    const l = await listen(api);
    server = l.server;
    const r = await request(l.port, 'OPTIONS', '/api/doctor', ALLOWED);
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-methods']).toBe('GET, POST');
  });
});
