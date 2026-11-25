// Build the scrubbed public snapshot of this repo and tag it.
//
// Usage: node scripts/release.mjs <X.Y.Z> [--apply] [--out <dir>] [--public <dir>]
//                                 [--skip-tests] [--notes-file <f>] [--source <repo dir>]
//
// Default is a dry run: the snapshot is built in a scratch dir and nothing else is written.
// --apply bumps versions and the changelog in the source repo, commits them, rebuilds the
// public repo working tree, commits and tags it. The push and the GitHub release are only
// printed, never run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = path.resolve(SCRIPT_DIR, '..');
const PUBLIC_DIR_NAME = 'claude-control-room-public';
const PUBLIC_SLUG = 'OAKHEN1412/claude-control-room';
const PUBLIC_AUTHOR_NAME = 'OAKHEN1412';
const PUBLIC_AUTHOR_EMAIL = '132264740+OAKHEN1412@users.noreply.github.com';
const WORKSPACES = ['server', 'web', 'cli', 'shared'];
const CHANGELOG_FILE = 'CHANGELOG.md';
const CHANGELOG_HEADER = '# Changelog';
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_BUFFER = 1024 * 1024 * 1024;

// Paths removed from the snapshot. A trailing slash means the whole directory.
// Entries containing "*" are shell-style globs matching within one path segment.
export const DROP_LIST = [
  'spikes/',
  'docs/mockup/',
  'docs/redesign/',
  'docs/spikes.md',
  'docs/permission-mode-check.md',
  'docs/stage*-check.md',
  'docs/DISTRIBUTION.md',
  'docs/PLAN.md',
];

// Built-in leak patterns. Private names never go here: this file ships publicly.
const ALLOWED_EMAIL_DOMAINS = new Set(['users.noreply.github.com', 'example.com']);
const ALLOWED_USER_PATH_NAMES = new Set(['you', '<user>', 'username', '%username%', 'public']);
const TAILSCALE_IP_RE =
  /(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?!\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const USER_PATH_RE = /C:[\\/]+Users[\\/]+([^\\/\s"'`]+)/gi;

const USAGE =
  'usage: node scripts/release.mjs <X.Y.Z> [--apply] [--out <dir>] [--public <dir>]\n' +
  '                                [--skip-tests] [--notes-file <f>] [--source <repo dir>]';

export function isValidVersion(version) {
  return typeof version === 'string' && VERSION_RE.test(version);
}

// True when candidate is a valid X.Y.Z strictly greater than current.
export function isNewerVersion(candidate, current) {
  if (!isValidVersion(candidate) || !isValidVersion(current)) return false;
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function readJsonFile(abs) {
  const raw = fs.readFileSync(abs, 'utf8');
  const text = raw.replace(/^\uFEFF/, '');
  const indentMatch = text.match(/^([ \t]+)"/m);
  return {
    obj: JSON.parse(text),
    indent: indentMatch ? indentMatch[1] : 2,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: text.endsWith('\n') || text.endsWith('\r\n'),
  };
}

function writeJsonFile(abs, obj, { indent, eol, trailingNewline }) {
  const body = JSON.stringify(obj, null, indent).replace(/\n/g, eol);
  fs.writeFileSync(abs, body + (trailingNewline ? eol : ''));
}

// Set "version" in root, server, web, cli and shared package.json files that exist, and in
// package-lock.json (packages[""], each workspace entry, top-level). Key order, indent and
// line endings are kept. Returns [{ file, from, to }] for every file that changed.
export function bumpVersions(rootDir, version) {
  if (!isValidVersion(version)) throw new Error(`bumpVersions: invalid version "${version}"`);
  const changed = [];
  const pkgFiles = ['package.json', ...WORKSPACES.map((w) => `${w}/package.json`)].filter((f) =>
    fs.existsSync(path.join(rootDir, f)),
  );
  for (const file of pkgFiles) {
    const abs = path.join(rootDir, file);
    const meta = readJsonFile(abs);
    const from = meta.obj.version;
    if (from === version) continue;
    meta.obj.version = version;
    writeJsonFile(abs, meta.obj, meta);
    changed.push({ file, from, to: version });
  }

  const lockFile = 'package-lock.json';
  const lockAbs = path.join(rootDir, lockFile);
  if (fs.existsSync(lockAbs)) {
    const meta = readJsonFile(lockAbs);
    const lock = meta.obj;
    let from = null;
    let dirty = false;
    const packages = lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
    for (const key of ['', ...WORKSPACES]) {
      const entry = packages[key];
      if (!entry || typeof entry !== 'object') continue;
      if (key !== '' && !('version' in entry)) continue;
      if (key === '') from = entry.version ?? from;
      if (entry.version !== version) {
        entry.version = version;
        dirty = true;
      }
    }
    if ('version' in lock && lock.version !== version) {
      from = from ?? lock.version;
      lock.version = version;
      dirty = true;
    }
    if (dirty) {
      writeJsonFile(lockAbs, lock, meta);
      changed.push({ file: lockFile, from, to: version });
    }
  }
  return changed;
}

function toBullets(notes) {
  const lines = String(notes ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return ['- Maintenance release.'];
  return lines.map((l) => (/^[-*]\s/.test(l) ? `-${l.slice(1)}` : `- ${l}`));
}

// Insert "## [version] - date" with the notes as bullets. When the changelog has an
// "## [Unreleased]" block, the new entry goes right after that block (Unreleased stays on
// top, empty); otherwise it goes at the top of the entries, below the "# Changelog" header.
// existing may be null for a new file.
export function prependChangelog(existing, version, date, notes) {
  const section = `## [${version}] - ${date}\n\n${toBullets(notes).join('\n')}\n`;
  const text = String(existing ?? '').replace(/\r\n/g, '\n');
  if (text.trim() === '') return `${CHANGELOG_HEADER}\n\n${section}`;
  let rest = text.replace(/^\s*# Changelog[^\n]*\n?/, '');
  rest = rest.replace(/^\s*\n/, '');
  if (rest.trim() === '') return `${CHANGELOG_HEADER}\n\n${section}`;
  if (!rest.endsWith('\n')) rest += '\n';
  const unreleased = /^## \[Unreleased\][^\n]*\n/m.exec(rest);
  if (unreleased) {
    const headEnd = unreleased.index + unreleased[0].length;
    const after = rest.slice(headEnd);
    const nextEntry = after.search(/^## \[/m);
    const body = nextEntry === -1 ? after : after.slice(0, nextEntry);
    const tail = nextEntry === -1 ? '' : after.slice(nextEntry);
    const block = `${rest.slice(0, headEnd)}${body}`.replace(/\s*$/, '\n');
    return `${CHANGELOG_HEADER}\n\n${block}\n${section}${tail ? `\n${tail}` : ''}`;
  }
  return `${CHANGELOG_HEADER}\n\n${section}\n${rest}`;
}

function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function escapeRegExp(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function matchesDrop(rel, entry) {
  if (entry.endsWith('/')) {
    const base = entry.slice(0, -1);
    return rel === base || rel.startsWith(entry);
  }
  if (entry.includes('*')) {
    const pattern = entry.split('*').map(escapeRegExp).join('[^/]*');
    return new RegExp(`^${pattern}$`).test(rel);
  }
  return rel === entry;
}

// Returns the subset of paths that the snapshot must drop (per DROP_LIST).
export function filterDropped(paths) {
  return paths
    .map((p) => normalizeRel(p))
    .filter((rel) => DROP_LIST.some((entry) => matchesDrop(rel, entry)));
}

// Every file and directory under dir as posix paths relative to dir.
function listEntries(dir) {
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      out.push(childRel);
      if (d.isDirectory()) walk(childRel);
    }
  };
  walk('');
  return out;
}

// Text files under dir as posix relative paths. Skips node_modules and .git.
function listTextFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name === '.git') continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(childRel);
      else if (d.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out;
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function truncate(s) {
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

function compileExtra(extraPatterns) {
  return extraPatterns
    .map((p) => String(p).trim())
    .filter((p) => p.length > 0 && !p.startsWith('#'))
    .map((p, i) => ({ label: `private-pattern-${i + 1}`, re: new RegExp(p, 'gi') }));
}

// Leak scan over the text files in dir. extraPatterns are regex sources (case-insensitive).
// Returns [{ file, line, label, match }]; match is truncated.
export function scanLeaks(dir, extraPatterns = []) {
  const builtin = [
    { label: 'tailscale-ip', re: TAILSCALE_IP_RE },
    {
      label: 'email',
      re: EMAIL_RE,
      allow: (m) => ALLOWED_EMAIL_DOMAINS.has(m[0].slice(m[0].indexOf('@') + 1).toLowerCase()),
    },
    {
      label: 'user-path',
      re: USER_PATH_RE,
      allow: (m) => ALLOWED_USER_PATH_NAMES.has(String(m[1]).toLowerCase()),
    },
  ];
  const patterns = [...builtin, ...compileExtra(extraPatterns)];
  const hits = [];
  for (const rel of listTextFiles(dir)) {
    const buf = fs.readFileSync(path.join(dir, rel));
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const pat of patterns) {
        for (const m of line.matchAll(pat.re)) {
          if (pat.allow && pat.allow(m)) continue;
          hits.push({ file: rel, line: idx + 1, label: pat.label, match: truncate(m[0]) });
        }
      }
    });
  }
  return hits;
}

// Extra leak regexes, one per line, from CR_LEAK_PATTERNS or
// <CR_DATA_DIR or ~/.claude-control-room>/leak-patterns.txt. Missing default file = none;
// missing file named by CR_LEAK_PATTERNS is an error.
export function loadLeakPatterns(env = process.env, homeDir = os.homedir()) {
  const explicit = env.CR_LEAK_PATTERNS;
  const file =
    explicit ||
    path.join(env.CR_DATA_DIR || path.join(homeDir, '.claude-control-room'), 'leak-patterns.txt');
  if (!fs.existsSync(file)) {
    if (explicit) throw new Error(`CR_LEAK_PATTERNS points at a missing file`);
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDate(now) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function localStamp(now) {
  return `${localDate(now).replace(/-/g, '')}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function quoteArg(s) {
  return /\s/.test(s) ? `"${s}"` : s;
}

const STEP_TITLES = {
  validate: 'validate version and compare with the current root version',
  'clean-check': 'refuse on a dirty source tree; check the public repo and tag',
  bump: 'bump versions in package.json files and package-lock.json',
  changelog: 'prepend the CHANGELOG.md entry',
  tests: 'run npm test and npm run build in the source repo',
  snapshot: 'git archive HEAD into the snapshot dir, drop DROP_LIST paths, bump and changelog the snapshot',
  'leak-scan': 'leak scan over the snapshot',
  'commit-source': 'commit the release bump in the source repo',
  'publish-public': 'replace the public repo working tree, commit as OAKHEN1412, tag',
  handoff: 'print the push and GitHub release commands (not run)',
};

// Describes what a release would do. Pure: no file or git access.
export function planRelease(opts) {
  const apply = Boolean(opts.apply);
  const now = opts.now ?? new Date();
  const source = path.resolve(opts.source ?? DEFAULT_SOURCE);
  const publicDir = path.resolve(opts.publicDir ?? path.join(source, '..', PUBLIC_DIR_NAME));
  const workDir = path.resolve(
    opts.out ?? path.join(os.tmpdir(), `cr-release-${opts.version}-${localStamp(now)}`),
  );
  const notesFile = opts.notesFile
    ? path.resolve(opts.notesFile)
    : `${workDir}-notes.md`;
  const ids = apply
    ? ['validate', 'clean-check', 'bump', 'changelog', 'tests', 'snapshot', 'leak-scan', 'commit-source', 'publish-public', 'handoff']
    : ['validate', 'bump', 'changelog', 'tests', 'snapshot', 'leak-scan', 'handoff'];
  const steps = ids
    .filter((id) => !(opts.skipTests && id === 'tests'))
    .map((id) => ({ id, title: STEP_TITLES[id] }));
  const tag = `v${opts.version}`;
  const pubPath = quoteArg(publicDir);
  return {
    mode: apply ? 'apply' : 'dry-run',
    version: opts.version,
    tag,
    date: localDate(now),
    source,
    publicDir,
    workDir,
    notesFile,
    steps,
    push: `git -C ${pubPath} -c credential.helper='' -c 'credential.helper=!f() { echo username=OAKHEN1412; echo "password=$(gh auth token --user OAKHEN1412)"; }; f' push origin main --follow-tags`,
    release: `gh release create ${tag} --repo ${PUBLIC_SLUG} --title "${tag}" --notes-file ${quoteArg(notesFile)}`,
  };
}

function git(cwd, args, extra = {}) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    ...extra,
  });
}

function gitOk(cwd, args) {
  return git(cwd, args).status === 0;
}

function isGitRepo(dir) {
  if (!fs.existsSync(dir)) return false;
  const r = git(dir, ['rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && r.stdout.trim() === 'true';
}

function tagExists(dir, tag) {
  return gitOk(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
}

function gitSubjects(source, since) {
  const range = since ? [`${since}..HEAD`] : [];
  const r = git(source, ['log', '--pretty=%s', ...range]);
  if (r.status !== 0) throw new Error(`git log failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function lastTagOf(source) {
  const r = git(source, ['describe', '--tags', '--abbrev=0', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : null;
}

function writeChangelog(dir, version, date, notes) {
  const abs = path.join(dir, CHANGELOG_FILE);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  fs.writeFileSync(abs, prependChangelog(existing, version, date, notes));
}

function tail(text, lines = 40) {
  return text.split(/\r?\n/).slice(-lines).join('\n');
}

// Restore source files we touched. Only called when the tree was clean before we started.
function restoreSource(source, files) {
  for (const f of files) {
    const tracked = gitOk(source, ['ls-files', '--error-unmatch', '--', f]);
    if (tracked) git(source, ['checkout', '--', f]);
    else fs.rmSync(path.join(source, f), { force: true });
  }
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const opts = {
    version: null,
    apply: false,
    skipTests: false,
    out: null,
    publicDir: null,
    notesFile: null,
    source: null,
    help: false,
  };
  const valued = { '--out': 'out', '--public': 'publicDir', '--notes-file': 'notesFile', '--source': 'source' };
  const flags = { '--apply': 'apply', '--skip-tests': 'skipTests', '-h': 'help', '--help': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(flags, arg)) {
      opts[flags[arg]] = true;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const key = Object.hasOwn(valued, arg.slice(0, eq)) ? valued[arg.slice(0, eq)] : null;
      if (!key) throw new Error(`unknown option ${arg.slice(0, eq)}`);
      opts[key] = arg.slice(eq + 1);
    } else if (Object.hasOwn(valued, arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      opts[valued[arg]] = value;
      i++;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else if (opts.version === null) {
      opts.version = arg;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  return opts;
}

function runRelease(opts, env, log) {
  const version = opts.version;
  if (!isValidVersion(version)) fail(`version must look like X.Y.Z, got "${version}"`);
  const plan = planRelease({ ...opts, version, now: new Date() });
  const apply = plan.mode === 'apply';
  const source = plan.source;
  const total = plan.steps.length;
  let n = 0;
  const say = (id, suffix = '') => {
    n++;
    const step = plan.steps.find((s) => s.id === id);
    log(`[${n}/${total}] ${step ? step.title : id}${suffix}`);
  };

  log(`release ${plan.tag} (${plan.mode})`);
  log(`  source:  ${source}`);
  log(`  public:  ${plan.publicDir}${apply ? '' : ' (read only in dry-run)'}`);
  log(`  scratch: ${plan.workDir}`);

  // 1. validate
  say('validate');
  const rootPkg = readJsonFile(path.join(source, 'package.json')).obj;
  const current = rootPkg.version;
  if (!isNewerVersion(version, current)) {
    fail(`${version} is not greater than the current root version ${current}`);
  }
  if (!isGitRepo(source)) fail(`source is not a git repo: ${source}`);
  log(`  ${current} -> ${version}`);

  // 2. clean-check
  if (apply) {
    say('clean-check');
    const status = git(source, ['status', '--porcelain']).stdout.trim();
    if (status) fail('source tree is dirty; commit or stash your changes before --apply');
    if (!isGitRepo(plan.publicDir)) {
      fail(`public repo is not a git repo: ${plan.publicDir}`);
    }
    if (tagExists(source, plan.tag) || tagExists(plan.publicDir, plan.tag)) {
      fail(`tag ${plan.tag} already exists`);
    }
  } else if (!isGitRepo(plan.publicDir)) {
    log(`  note: public repo not found or not a git repo (apply would refuse): ${plan.publicDir}`);
  }
  if (!apply && git(source, ['status', '--porcelain']).stdout.trim()) {
    log('  note: source has uncommitted changes; the snapshot is built from HEAD and will not include them');
  }

  // Source files touched in apply mode, restored if anything fails before the source commit.
  const touched = [];
  const rollback = () => {
    if (apply && touched.length) restoreSource(source, touched);
  };

  try {
    // 3. bump (source only in apply; dry-run bumps the snapshot later)
    say('bump');
    if (apply) {
      for (const c of bumpVersions(source, version)) touched.push(c.file);
      log(`  ${touched.length} file(s) bumped in source`);
    }

    // 4. changelog
    say('changelog');
    let notesText;
    if (opts.notesFile) {
      const notesPath = path.resolve(opts.notesFile);
      if (!fs.existsSync(notesPath)) fail(`notes file not found: ${notesPath}`);
      notesText = fs.readFileSync(notesPath, 'utf8');
    } else {
      notesText = gitSubjects(source, lastTagOf(source));
    }
    if (apply) {
      writeChangelog(source, version, plan.date, notesText);
      touched.push(CHANGELOG_FILE);
    }
    if (!opts.notesFile) {
      fs.mkdirSync(path.dirname(plan.notesFile), { recursive: true });
      fs.writeFileSync(plan.notesFile, toBullets(notesText).join('\n') + '\n');
    }

    // 5. tests
    if (!opts.skipTests) {
      say('tests');
      for (const args of [['test'], ['run', 'build']]) {
        const r = spawnSync('npm', args, { cwd: source, shell: true, encoding: 'utf8', maxBuffer: MAX_BUFFER });
        if (r.status !== 0) {
          const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
          fail(`npm ${args.join(' ')} failed (exit ${r.status})\n${tail(out)}`);
        }
        log(`  npm ${args.join(' ')}: ok`);
      }
    } else {
      log('  (tests skipped: --skip-tests)');
    }

    // 6. snapshot
    say('snapshot');
    if (fs.existsSync(plan.workDir) && fs.readdirSync(plan.workDir).length > 0) {
      fail(`scratch dir is not empty: ${plan.workDir}`);
    }
    fs.mkdirSync(plan.workDir, { recursive: true });
    const archive = spawnSync('git', ['-C', source, 'archive', '--format=tar', 'HEAD'], {
      maxBuffer: MAX_BUFFER,
    });
    if (archive.status !== 0) fail(`git archive failed: ${String(archive.stderr).trim()}`);
    // cwd, not -C: GNU tar (Git Bash) misreads a Windows drive path given to -C.
    const extract = spawnSync('tar', ['-x', '-f', '-'], {
      cwd: plan.workDir,
      input: archive.stdout,
      maxBuffer: MAX_BUFFER,
    });
    if (extract.status !== 0) fail(`tar extract failed: ${String(extract.stderr).trim()}`);

    // 6b. drop list, then bump and changelog in the snapshot
    const dropped = filterDropped(listEntries(plan.workDir));
    for (const rel of dropped) fs.rmSync(path.join(plan.workDir, rel), { recursive: true, force: true });
    log(`  dropped ${dropped.length} path(s) from the snapshot`);
    bumpVersions(plan.workDir, version);
    writeChangelog(plan.workDir, version, plan.date, notesText);

    // 7. leak scan (before any write to the public repo or source commit)
    say('leak-scan');
    const extra = loadLeakPatterns(env);
    const hits = scanLeaks(plan.workDir, extra);
    if (hits.length) {
      for (const h of hits) log(`  LEAK ${h.file}:${h.line} [${h.label}] ${h.match}`);
      fail(`leak scan found ${hits.length} hit(s); nothing committed`);
    }
    log(`  clean (${extra.length} private pattern(s) applied)`);

    if (apply) {
      // 8. commit source
      say('commit-source');
      const add = git(source, ['add', '--', ...touched]);
      if (add.status !== 0) fail(`git add failed: ${add.stderr.trim()}`);
      const commit = git(source, ['commit', '-m', `release ${plan.tag}`]);
      if (commit.status !== 0) fail(`source commit failed: ${(commit.stderr || commit.stdout).trim()}`);
      touched.length = 0;
      log(`  committed in source: release ${plan.tag}`);

      // 9. publish to the public repo working tree
      say('publish-public');
      for (const entry of fs.readdirSync(plan.publicDir)) {
        if (entry === '.git') continue;
        fs.rmSync(path.join(plan.publicDir, entry), { recursive: true, force: true });
      }
      fs.cpSync(plan.workDir, plan.publicDir, { recursive: true });
      const pubAdd = git(plan.publicDir, ['add', '-A']);
      if (pubAdd.status !== 0) fail(`public git add failed: ${pubAdd.stderr.trim()}`);
      if (gitOk(plan.publicDir, ['diff', '--cached', '--quiet'])) {
        fail('public repo has nothing new to commit');
      }
      const pubCommit = git(plan.publicDir, [
        '-c',
        `user.name=${PUBLIC_AUTHOR_NAME}`,
        '-c',
        `user.email=${PUBLIC_AUTHOR_EMAIL}`,
        'commit',
        '-m',
        `Release ${plan.tag}`,
      ]);
      if (pubCommit.status !== 0) fail(`public commit failed: ${(pubCommit.stderr || pubCommit.stdout).trim()}`);
      const pubTag = git(plan.publicDir, ['tag', plan.tag]);
      if (pubTag.status !== 0) fail(`public tag failed: ${pubTag.stderr.trim()}`);
      log(`  public repo committed and tagged ${plan.tag}`);
    }
  } catch (err) {
    if (apply && touched.length) {
      rollback();
      log(`  source restored (${touched.join(', ')})`);
    }
    throw err;
  }

  // 10. handoff
  say('handoff');
  log(`  push (NOT run):    ${plan.push}`);
  log(`  release (NOT run): ${plan.release}`);
  log(`  notes file:        ${plan.notesFile}`);
  log(apply ? '  nothing was pushed.' : '  dry-run: the public repo and source were not touched. nothing was pushed.');
  return 0;
}

// Returns the process exit code: 0 ok, 1 release failed, 2 usage error.
export function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  if (!opts.version) {
    console.error(USAGE);
    return 2;
  }
  try {
    return runRelease(opts, env, log);
  } catch (err) {
    console.error(`release aborted: ${err.message}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main();
}
