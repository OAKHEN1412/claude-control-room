// scripts/release.mjs: version rules, version bump, changelog, drop list, leak scan, dry-run.
// Fixtures that look like private data (IPs, emails, user paths) are assembled at runtime so
// this file does not trip the leak scan when the public snapshot is built.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DROP_LIST,
  bumpVersions,
  filterDropped,
  isNewerVersion,
  isValidVersion,
  loadLeakPatterns,
  main,
  planRelease,
  prependChangelog,
  scanLeaks,
} from '../../scripts/release.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/release.mjs');
const BS = '\\';
const TS_IP = ['100', '64', '1', '2'].join('.');
const PRIVATE_EMAIL = ['dev', 'corp.test'].join('@');
const USER_PATH = ['C:', 'Users', 'Nobody'].join(BS) + BS + 'AppData';
const NOREPLY = ['132264740+ghuser', 'users.noreply.github.com'].join('@');
const EXAMPLE = ['someone', 'example.com'].join('@');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-release-test-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function write(rel: string, text: string, root = tmp) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

describe('version validation and comparison', () => {
  it('accepts only plain X.Y.Z', () => {
    expect(isValidVersion('0.1.0')).toBe(true);
    expect(isValidVersion('12.0.345')).toBe(true);
    expect(isValidVersion('1.2')).toBe(false);
    expect(isValidVersion('v1.2.3')).toBe(false);
    expect(isValidVersion('1.2.3-beta')).toBe(false);
    expect(isValidVersion('1.2.3\n')).toBe(false);
    expect(isValidVersion('')).toBe(false);
  });

  it('compares numerically, not as strings', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false);
    expect(isNewerVersion('bogus', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.2.0', 'bogus')).toBe(false);
  });
});

describe('bumpVersions', () => {
  it('bumps package.json files and lock entries, keeping indent, CRLF and key order', () => {
    const root = path.join(tmp, 'repo');
    const pkgRoot = JSON.stringify(
      { name: 'claude-control-room', version: '0.1.0', private: true, workspaces: ['server', 'web'] },
      null,
      4,
    ).replace(/\n/g, '\r\n') + '\r\n';
    write('repo/package.json', pkgRoot);
    write('repo/server/package.json', '{\n  "name": "cr-server",\n  "version": "0.1.0",\n  "type": "module"\n}');
    write('repo/web/package.json', '{\n  "name": "cr-web",\n  "version": "0.1.0"\n}\n');
    // cli and shared do not exist in this fake repo: they must be skipped, not created.
    const lock = {
      name: 'claude-control-room',
      version: '0.1.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'claude-control-room', version: '0.1.0', workspaces: ['server', 'web'] },
        server: { name: 'cr-server', version: '0.1.0' },
        web: { name: 'cr-web', version: '0.1.0' },
        'node_modules/cr-server': { resolved: 'server', link: true },
        'node_modules/left-pad': { version: '1.3.0' },
      },
    };
    write('repo/package-lock.json', JSON.stringify(lock, null, 2) + '\n');

    const changed = bumpVersions(root, '0.2.0');
    expect(changed.map((c) => c.file).sort()).toEqual(
      ['package-lock.json', 'package.json', 'server/package.json', 'web/package.json'].sort(),
    );

    const rootText = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    expect(rootText).toBe(
      JSON.stringify(
        { name: 'claude-control-room', version: '0.2.0', private: true, workspaces: ['server', 'web'] },
        null,
        4,
      ).replace(/\n/g, '\r\n') + '\r\n',
    );
    expect(rootText).toContain('\r\n    "version": "0.2.0"');

    expect(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')).toBe(
      '{\n  "name": "cr-server",\n  "version": "0.2.0",\n  "type": "module"\n}',
    );
    expect(fs.readFileSync(path.join(root, 'web/package.json'), 'utf8')).toBe(
      '{\n  "name": "cr-web",\n  "version": "0.2.0"\n}\n',
    );
    expect(fs.existsSync(path.join(root, 'cli'))).toBe(false);

    const newLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    expect(newLock.version).toBe('0.2.0');
    expect(newLock.packages[''].version).toBe('0.2.0');
    expect(newLock.packages.server.version).toBe('0.2.0');
    expect(newLock.packages.web.version).toBe('0.2.0');
    expect(newLock.packages['node_modules/left-pad'].version).toBe('1.3.0');
    expect(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8').endsWith('\n')).toBe(true);
    expect(Object.keys(newLock)).toEqual(Object.keys(lock));
  });

  it('reports nothing changed when the version is already set', () => {
    write('r/package.json', '{\n  "version": "0.3.0"\n}\n');
    expect(bumpVersions(path.join(tmp, 'r'), '0.3.0')).toEqual([]);
  });

  it('refuses an invalid version', () => {
    expect(() => bumpVersions(tmp, 'x.y')).toThrow(/invalid version/);
  });
});

describe('prependChangelog', () => {
  it('creates a new file with the header, the entry and bullets', () => {
    const text = prependChangelog(null, '0.2.0', '2026-12-01', '* first change\n  \nsecond change');
    expect(text).toBe('# Changelog\n\n## [0.2.0] - 2026-12-01\n\n- first change\n- second change\n');
  });

  it('uses a placeholder bullet when there are no notes', () => {
    const text = prependChangelog('', '0.2.0', '2026-12-01', '   \n');
    expect(text).toContain('- Maintenance release.');
  });

  it('inserts the entry right after the empty Unreleased block and keeps the older entries', () => {
    const existing =
      '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-25\n\n- First public-ready snapshot.\n';
    const text = prependChangelog(existing, '0.2.0', '2026-12-01', 'a\nb');
    expect(text).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-12-01\n\n- a\n- b\n\n## [0.1.0] - 2026-11-25\n\n- First public-ready snapshot.\n',
    );
  });

  it('keeps unreleased notes under Unreleased and puts the new entry below them', () => {
    const existing =
      '# Changelog\n\n## [Unreleased]\n\n- pending item\n\n## [0.1.0] - 2026-11-25\n\n- old\n';
    const text = prependChangelog(existing, '0.2.0', '2026-12-01', 'new');
    expect(text).toBe(
      '# Changelog\n\n## [Unreleased]\n\n- pending item\n\n## [0.2.0] - 2026-12-01\n\n- new\n\n## [0.1.0] - 2026-11-25\n\n- old\n',
    );
  });

  it('appends after an Unreleased block that is the last section', () => {
    const existing = '# Changelog\n\n## [Unreleased]\n\n- only pending\n';
    const text = prependChangelog(existing, '0.2.0', '2026-12-01', 'new');
    expect(text).toBe(
      '# Changelog\n\n## [Unreleased]\n\n- only pending\n\n## [0.2.0] - 2026-12-01\n\n- new\n',
    );
  });

  it('adds the header when an existing file has none', () => {
    const text = prependChangelog('## [0.1.0] - 2026-11-25\n\n- old\n', '0.2.0', '2026-12-01', 'new');
    expect(text.startsWith('# Changelog\n\n## [0.2.0] - 2026-12-01\n\n- new\n\n## [0.1.0]')).toBe(true);
  });
});

describe('filterDropped', () => {
  it('returns exactly the paths on the drop list', () => {
    expect(DROP_LIST).toContain('spikes/');
    const dropped = filterDropped([
      'spikes',
      'spikes/x',
      'spikes/deep/y.ts',
      'docs/mockup',
      'docs/mockup/index.html',
      'docs/redesign/a.md',
      'docs/spikes.md',
      'docs/permission-mode-check.md',
      'docs/stage2-check.md',
      'docs/stage10-check.md',
      'docs/DISTRIBUTION.md',
      'spikes\\win\\z.ts',
      './docs/spikes.md',
    ]);
    expect(dropped).toEqual([
      'spikes',
      'spikes/x',
      'spikes/deep/y.ts',
      'docs/mockup',
      'docs/mockup/index.html',
      'docs/redesign/a.md',
      'docs/spikes.md',
      'docs/permission-mode-check.md',
      'docs/stage2-check.md',
      'docs/stage10-check.md',
      'docs/DISTRIBUTION.md',
      'spikes/win/z.ts',
      'docs/spikes.md',
    ]);
  });

  it('keeps paths that only look similar', () => {
    expect(
      filterDropped([
        'docs/README.md',
        'docs/stage2-check.txt',
        'docs/stage2/check.md',
        'server/src/spikes.ts',
        'docs/spikes.md.bak',
        'spikesfoo/a.ts',
        'docs/DISTRIBUTION.md.old',
      ]),
    ).toEqual([]);
  });
});

describe('scanLeaks', () => {
  it('flags a Tailscale IP, a private email, a user path and a custom pattern', () => {
    const dir = path.join(tmp, 'snap');
    write('snap/a.md', `host is ${TS_IP} here\n`);
    write('snap/b.ts', `contact ${PRIVATE_EMAIL}\n`);
    write('snap/c.txt', `path ${USER_PATH}\n`);
    write('snap/d.md', 'the secret codename is ZEBRA-PLAN\n');
    const hits = scanLeaks(dir, ['zebra-\\w+']);
    const labels = hits.map((h) => `${h.file}:${h.label}`).sort();
    expect(labels).toEqual(['a.md:tailscale-ip', 'b.ts:email', 'c.txt:user-path', 'd.md:private-pattern-1']);
    const hit = hits.find((h) => h.label === 'tailscale-ip');
    expect(hit?.line).toBe(1);
    expect(hit?.match).toBe(TS_IP);
  });

  it('does not flag noreply, example.com, placeholder user paths or non-Tailscale IPs', () => {
    const dir = path.join(tmp, 'clean');
    write('clean/a.md', `author ${NOREPLY} and ${EXAMPLE}\n`);
    write('clean/b.md', `user ${'C:' + BS + 'Users' + BS}you and ${'C:/Users/'}<user> and ${'C:' + BS + 'Users' + BS}Public\n`);
    write('clean/c.md', `${'C:' + BS + 'Users' + BS}USERNAME and ${'C:/Users/'}%USERNAME%\n`);
    write('clean/d.md', 'lan 192.168.1.10 and 100.128.0.1 and 1100.64.1.2\n');
    expect(scanLeaks(dir)).toEqual([]);
  });

  it('skips binary files and node_modules', () => {
    const dir = path.join(tmp, 'bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(TS_IP)]));
    write('bin/node_modules/pkg/x.js', `${PRIVATE_EMAIL}\n`);
    expect(scanLeaks(dir)).toEqual([]);
  });

  it('loads extra patterns from CR_LEAK_PATTERNS, one per line, skipping comments', () => {
    const file = write('patterns.txt', '# private names\n\nzebra-\\w+\nquokka\n');
    expect(loadLeakPatterns({ CR_LEAK_PATTERNS: file } as NodeJS.ProcessEnv)).toEqual([
      'zebra-\\w+',
      'quokka',
    ]);
    expect(() =>
      loadLeakPatterns({ CR_LEAK_PATTERNS: path.join(tmp, 'missing.txt') } as NodeJS.ProcessEnv),
    ).toThrow(/missing file/);
  });

  it('reads the default patterns file from CR_DATA_DIR when no explicit file is set', () => {
    write('data/leak-patterns.txt', 'otter\n');
    expect(loadLeakPatterns({ CR_DATA_DIR: path.join(tmp, 'data') } as NodeJS.ProcessEnv)).toEqual(['otter']);
    expect(loadLeakPatterns({ CR_DATA_DIR: path.join(tmp, 'none') } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('planRelease', () => {
  it('describes a dry run into a scratch dir and prints the push and release commands', () => {
    const plan = planRelease({
      version: '0.2.0',
      source: path.join(tmp, 'src'),
      now: new Date(2026, 10, 25, 9, 5, 7),
    });
    expect(plan.mode).toBe('dry-run');
    expect(plan.workDir).toBe(path.resolve(path.join(os.tmpdir(), 'cr-release-0.2.0-20261125-090507')));
    expect(plan.publicDir).toBe(path.resolve(path.join(tmp, 'claude-control-room-public')));
    expect(plan.steps.map((s) => s.id)).not.toContain('commit-source');
    expect(plan.release).toContain('gh release create v0.2.0 --repo OAKHEN1412/claude-control-room');
    expect(plan.push).toContain('push origin main --follow-tags');
  });

  it('lists the apply-only steps when applying and drops tests with --skip-tests', () => {
    const plan = planRelease({ version: '0.2.0', source: tmp, apply: true, skipTests: true });
    const ids = plan.steps.map((s) => s.id);
    expect(plan.mode).toBe('apply');
    expect(ids).toEqual(expect.arrayContaining(['clean-check', 'commit-source', 'publish-public']));
    expect(ids).not.toContain('tests');
  });
});

describe('CLI argument handling', () => {
  it('exits 2 on usage errors without touching anything', () => {
    const log = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main([], {} as NodeJS.ProcessEnv, log)).toBe(2);
    expect(main(['0.2.0', '--bogus'], {} as NodeJS.ProcessEnv, log)).toBe(2);
    expect(main(['0.2.0', '--out'], {} as NodeJS.ProcessEnv, log)).toBe(2);
    expect(err).toHaveBeenCalled();
  });

  it('refuses a version that is not newer than the root version', () => {
    const repo = makeFakeRepo(tmp);
    const scratch = path.join(tmp, 'scratch-refused');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = main(['0.1.0', '--source', repo, '--out', scratch, '--skip-tests'], cleanEnv(tmp), () => {});
    expect(code).toBe(1);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it('refuses a malformed version', () => {
    const repo = makeFakeRepo(tmp);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['v0.2', '--source', repo, '--skip-tests'], cleanEnv(tmp), () => {})).toBe(1);
  });
});

// A tiny git repo with a root package.json at 0.1.0, a doc to keep, and files to drop.
function makeFakeRepo(parent: string): string {
  const repo = path.join(parent, 'fake-src');
  fs.mkdirSync(repo, { recursive: true });
  const g = (args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  // Keep LF in the archive even when the machine's global autocrlf is on.
  g(['config', 'core.autocrlf', 'false']);
  write('fake-src/package.json', '{\n  "name": "fake",\n  "version": "0.1.0",\n  "private": true\n}\n');
  write('fake-src/package-lock.json', '{\n  "name": "fake",\n  "version": "0.1.0",\n  "packages": {\n    "": {\n      "name": "fake",\n      "version": "0.1.0"\n    }\n  }\n}\n');
  write('fake-src/README.md', '# fake\n');
  write('fake-src/docs/keep.md', 'keep me\n');
  write('fake-src/docs/spikes.md', 'private spike notes\n');
  write('fake-src/spikes/x', 'spike code\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'first subject']);
  write('fake-src/CHANGELOG.md', '# old\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'second subject']);
  return repo;
}

function cleanEnv(parent: string): NodeJS.ProcessEnv {
  const patterns = path.join(parent, 'no-patterns.txt');
  fs.writeFileSync(patterns, '');
  return { ...process.env, CR_LEAK_PATTERNS: patterns };
}

function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (child === '.git') continue; // git rewrites its index on status; compare the work tree only
      if (d.isDirectory()) walk(child);
      else out[child] = fs.readFileSync(path.join(dir, child), 'base64');
    }
  };
  walk('');
  return out;
}

describe('full dry run in a fake repo', () => {
  it('builds the scrubbed snapshot in the scratch dir and never touches the source', () => {
    const repo = makeFakeRepo(tmp);
    const scratch = path.join(tmp, 'scratch-dry');
    const before = readTree(repo);
    const gitBefore = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });

    const out = execFileSync(
      process.execPath,
      [SCRIPT, '0.2.0', '--source', repo, '--out', scratch, '--skip-tests'],
      { encoding: 'utf8', env: cleanEnv(tmp), stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // scratch holds the bumped versions and the changelog entry
    expect(JSON.parse(fs.readFileSync(path.join(scratch, 'package.json'), 'utf8')).version).toBe('0.2.0');
    const lock = JSON.parse(fs.readFileSync(path.join(scratch, 'package-lock.json'), 'utf8'));
    expect(lock.version).toBe('0.2.0');
    expect(lock.packages[''].version).toBe('0.2.0');
    const changelog = fs.readFileSync(path.join(scratch, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toMatch(/^# Changelog\n\n## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}\n\n- second subject\n- first subject\n\n# old/);
    // dropped paths are gone, kept paths stay
    expect(fs.existsSync(path.join(scratch, 'spikes'))).toBe(false);
    expect(fs.existsSync(path.join(scratch, 'docs/spikes.md'))).toBe(false);
    expect(fs.readFileSync(path.join(scratch, 'docs/keep.md'), 'utf8')).toBe('keep me\n');
    expect(fs.existsSync(path.join(scratch, '.git'))).toBe(false);
    // the printed commands and the no-push line appear
    expect(out).toContain('dry-run');
    expect(out).toContain('gh release create v0.2.0 --repo OAKHEN1412/claude-control-room');
    expect(out).toContain('push origin main --follow-tags');
    expect(out).toContain('nothing was pushed');
    expect(out).toContain('(tests skipped: --skip-tests)');

    // the source repo is byte-identical and has no new commit
    expect(readTree(repo)).toEqual(before);
    expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(gitBefore);
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  }, 60000);
});
