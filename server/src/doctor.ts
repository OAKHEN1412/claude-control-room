// Environment doctor: checks the tools and sign-ins this app needs (node, git, claude, ffmpeg, Chrome, skills,
// plugins, Lemo styles, ElevenLabs key, data dir). Each check reports an id, a status and a short technical
// detail; the web UI translates the titles. Secret values are never read into a result: presence checks only.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir as defaultDataDir } from './cmdlog';
import { claudeDir as defaultClaudeDir } from './paths';
import { defaultLemoFile, parseLemoStyles } from './styles';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checkedAt: number;
  checks: DoctorCheck[];
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface DoctorDeps {
  exec(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }>;
  env: Record<string, string | undefined>;
  claudeDir: string;
  dataDir: string;
  home: string;
  fileExists(p: string): Promise<boolean>;
  readText(p: string): Promise<string | null>;
  listDir(p: string): Promise<DirEntry[]>;
  hasElevenKey(): Promise<boolean>;
  lemoFile: string;
  platform: string;
  nodeVersion: string;
}

const NODE_MIN = '22.18.0';

const FIX: Record<string, string> = {
  node: 'winget install OpenJS.NodeJS.LTS',
  git: 'winget install Git.Git',
  claude: 'irm https://claude.ai/install.ps1 | iex',
  claudeLogin: 'run: claude   (then sign in)',
  chrome: 'Install Chrome and the Claude in Chrome extension',
  ffmpeg: 'winget install Gyan.FFmpeg',
  ffprobe: 'winget install Gyan.FFmpeg',
  hyperframesSkills: 'npx --yes skills add heygen-com/hyperframes -g -y',
  lemoPlugin: 'claude plugin marketplace add lemomo-ai/lemo-opuscar then claude plugin install lemo-opuscar@lemolab',
  lemoStyles: 'node scripts/lemo-styles.mjs',
  elevenKey: 'Settings -> ElevenLabs key',
  dataDir: 'check that the data directory is writable (CR_DATA_DIR)',
};

/** Checks whose failure blocks a feature (fail); the rest only warn. Also the status used when a check throws. */
const FAIL_IF_BROKEN = new Set(['node', 'claude', 'ffmpeg', 'ffprobe', 'dataDir']);

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0]?.trim() ?? '';
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 160 ? `${m.slice(0, 160)}...` : m;
}

/** Compares dotted versions numerically: true when `v` >= `min`. */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Install locations of Chrome on Windows (Program Files x2 and the per-user install). */
export function chromeCandidates(env: Record<string, string | undefined>): string[] {
  const rel = path.join('Google', 'Chrome', 'Application', 'chrome.exe');
  const out: string[] = [];
  if (env.ProgramFiles) out.push(path.join(env.ProgramFiles, rel));
  if (env['ProgramFiles(x86)']) out.push(path.join(env['ProgramFiles(x86)'] as string, rel));
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, rel));
  return out;
}

export function defaultExec(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        const out = String(stdout ?? '');
        if (!err) {
          resolve({ code: 0, stdout: out });
          return;
        }
        const code = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null;
        resolve({ code, stdout: out });
      });
    } catch {
      resolve({ code: null, stdout: '' });
    }
  });
}

/** True when ELEVENLABS_API_KEY is set, or the secret chain (if present) has it. Only presence is reported. */
export async function defaultHasElevenKey(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if ((env.ELEVENLABS_API_KEY ?? '').trim() !== '') return true;
  try {
    const spec = './secretChain';
    const mod = (await import(spec)) as { createDefaultChain?: () => unknown };
    if (typeof mod.createDefaultChain !== 'function') return false;
    const chain = mod.createDefaultChain() as { get?: (name: string) => Promise<string | null | undefined> };
    if (typeof chain.get !== 'function') return false;
    const v = await chain.get('elevenlabs');
    return typeof v === 'string' && v.trim() !== '';
  } catch {
    return false;
  }
}

function defaultDeps(): DoctorDeps {
  return {
    exec: defaultExec,
    env: process.env,
    claudeDir: defaultClaudeDir(),
    dataDir: defaultDataDir(),
    home: os.homedir(),
    fileExists: (p) => fs.promises.access(p).then(() => true, () => false),
    readText: (p) => fs.promises.readFile(p, 'utf8').catch(() => null),
    listDir: (p) =>
      fs.promises.readdir(p, { withFileTypes: true }).then(
        (es) => es.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
        () => [],
      ),
    hasElevenKey: () => defaultHasElevenKey(process.env),
    lemoFile: defaultLemoFile(),
    platform: process.platform,
    nodeVersion: process.versions.node,
  };
}

type CheckResult = Omit<DoctorCheck, 'id'>;

async function checkNode(d: DoctorDeps): Promise<CheckResult> {
  const v = d.nodeVersion;
  if (versionAtLeast(v, NODE_MIN)) return { status: 'ok', detail: `v${v}` };
  return { status: 'fail', detail: `v${v} (need >= ${NODE_MIN})`, fix: FIX.node };
}

async function checkGit(d: DoctorDeps): Promise<CheckResult> {
  const r = await d.exec('git', ['--version']);
  if (r.code === 0) return { status: 'ok', detail: firstLine(r.stdout) || 'found' };
  return { status: 'warn', detail: 'git not found', fix: FIX.git };
}

async function checkClaude(d: DoctorDeps): Promise<CheckResult> {
  const bin = (d.env.CR_CLAUDE_BIN ?? '').trim() || 'claude';
  const r = await d.exec(bin, ['--version']);
  if (r.code === 0) return { status: 'ok', detail: firstLine(r.stdout) || 'found' };
  return { status: 'fail', detail: `${bin} not found`, fix: FIX.claude };
}

async function checkClaudeLogin(d: DoctorDeps): Promise<CheckResult> {
  if (await d.fileExists(path.join(d.claudeDir, '.credentials.json'))) return { status: 'ok', detail: 'credentials file present' };
  const text = await d.readText(path.join(d.home, '.claude.json'));
  if (text !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    // Key presence only: the value (account email etc.) is never read into the result.
    if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'oauthAccount')) {
      return { status: 'ok', detail: 'account present in .claude.json' };
    }
  }
  return { status: 'warn', detail: 'not signed in', fix: FIX.claudeLogin };
}

async function checkChrome(d: DoctorDeps): Promise<CheckResult> {
  if (d.platform !== 'win32') return { status: 'warn', detail: `not checked on ${d.platform}`, fix: FIX.chrome };
  for (const p of chromeCandidates(d.env)) {
    if (await d.fileExists(p)) return { status: 'ok', detail: 'chrome found' };
  }
  return { status: 'warn', detail: 'chrome not found', fix: FIX.chrome };
}

async function checkBinary(d: DoctorDeps, cmd: 'ffmpeg' | 'ffprobe'): Promise<CheckResult> {
  const r = await d.exec(cmd, ['-version']);
  if (r.code === 0) return { status: 'ok', detail: firstLine(r.stdout) || 'found' };
  return { status: 'fail', detail: `${cmd} not found`, fix: FIX[cmd] };
}

async function checkHyperframesSkills(d: DoctorDeps): Promise<CheckResult> {
  const roots = [path.join(d.claudeDir, 'skills'), path.join(d.home, '.agents', 'skills')];
  for (const root of roots) {
    if (await d.fileExists(path.join(root, 'hyperframes', 'SKILL.md'))) return { status: 'ok', detail: 'hyperframes skill installed' };
  }
  return { status: 'warn', detail: 'hyperframes skill not installed', fix: FIX.hyperframesSkills };
}

async function checkLemoPlugin(d: DoctorDeps): Promise<CheckResult> {
  const pluginsDir = path.join(d.claudeDir, 'plugins');
  const text = await d.readText(path.join(pluginsDir, 'installed_plugins.json'));
  if (text !== null) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const plugins = obj.plugins && typeof obj.plugins === 'object' ? (obj.plugins as Record<string, unknown>) : obj;
      const key = Object.keys(plugins).find((k) => k.startsWith('lemo-opuscar@'));
      if (key) return { status: 'ok', detail: key };
    } catch {
      // corrupt file: fall through to the marketplace folder check
    }
  }
  const markets = await d.listDir(path.join(pluginsDir, 'marketplaces'));
  const lemo = markets.find((e) => e.name.toLowerCase().includes('lemo'));
  if (lemo) return { status: 'ok', detail: `marketplace ${lemo.name}` };
  const why = text === null ? 'not installed' : 'not installed (installed_plugins.json unreadable or no lemo entry)';
  return { status: 'warn', detail: why, fix: FIX.lemoPlugin };
}

async function checkLemoStyles(d: DoctorDeps): Promise<CheckResult> {
  const text = await d.readText(d.lemoFile);
  if (text === null) return { status: 'warn', detail: 'not installed', fix: FIX.lemoStyles };
  const list = parseLemoStyles(text.replace(/^\uFEFF/, ''));
  if (list.installed) return { status: 'ok', detail: `${list.styles.length} styles` };
  return { status: 'warn', detail: list.error ?? 'no styles in file', fix: FIX.lemoStyles };
}

async function checkElevenKey(d: DoctorDeps): Promise<CheckResult> {
  if (await d.hasElevenKey()) return { status: 'ok', detail: 'set' };
  return { status: 'warn', detail: 'not set', fix: FIX.elevenKey };
}

async function checkDataDir(d: DoctorDeps): Promise<CheckResult> {
  await fs.promises.mkdir(d.dataDir, { recursive: true });
  const probe = path.join(d.dataDir, `.doctor-${process.pid}-${Date.now()}.tmp`);
  await fs.promises.writeFile(probe, 'ok');
  await fs.promises.rm(probe, { force: true });
  return { status: 'ok', detail: d.dataDir };
}

const CHECKS: Array<[string, (d: DoctorDeps) => Promise<CheckResult>]> = [
  ['node', checkNode],
  ['git', checkGit],
  ['claude', checkClaude],
  ['claudeLogin', checkClaudeLogin],
  ['chrome', checkChrome],
  ['ffmpeg', (d) => checkBinary(d, 'ffmpeg')],
  ['ffprobe', (d) => checkBinary(d, 'ffprobe')],
  ['hyperframesSkills', checkHyperframesSkills],
  ['lemoPlugin', checkLemoPlugin],
  ['lemoStyles', checkLemoStyles],
  ['elevenKey', checkElevenKey],
  ['dataDir', checkDataDir],
];

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

/** Runs every check in parallel. A check that throws becomes a fail (or warn) result; the others still run. */
export async function runDoctor(overrides: Partial<DoctorDeps> = {}): Promise<DoctorReport> {
  const d: DoctorDeps = { ...defaultDeps(), ...stripUndefined(overrides) };
  const checks = await Promise.all(
    CHECKS.map(async ([id, fn]): Promise<DoctorCheck> => {
      try {
        return { id, ...(await fn(d)) };
      } catch (e) {
        const status: CheckStatus = FAIL_IF_BROKEN.has(id) ? 'fail' : 'warn';
        return { id, status, detail: `check error: ${errText(e)}`, fix: FIX[id] };
      }
    }),
  );
  return { ok: !checks.some((c) => c.status === 'fail'), checkedAt: Date.now(), checks };
}

const TAG: Record<CheckStatus, string> = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]' };

/** Prints one line per check plus a fix line when there is one. Returns the process exit code. */
export function printReport(report: DoctorReport, out: (line: string) => void = (l) => console.log(l)): number {
  for (const c of report.checks) {
    out(`${TAG[c.status]} ${c.id} - ${c.detail}`);
    if (c.fix && c.status !== 'ok') out(`   fix: ${c.fix}`);
  }
  return report.ok ? 0 : 1;
}

// Start only when this file is the entry point (tsx src/doctor.ts --cli), never on import.
const entry = process.argv[1];
if (entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) {
  runDoctor()
    .then((report) => {
      process.exitCode = printReport(report);
    })
    .catch((err: unknown) => {
      console.error(`doctor failed: ${errText(err)}`);
      process.exitCode = 1;
    });
}
