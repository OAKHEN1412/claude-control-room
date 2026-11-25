// scripts/lemo-styles.mjs: builds the style list from a fake Lemo-Opuscar library; round trip through styles.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLemoStyles,
  main,
  resolveLibDir,
  resolveOutFile,
  writeLemoStyles,
} from '../../scripts/lemo-styles.mjs';
import { defaultLemoFile, lemoThumbFile, loadLemoStyles, parseLemoStyles } from '../src/styles';

const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-lemo-'));
  tmp.push(d);
  return d;
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function slash(p: string): string {
  return p.split(path.sep).join('/');
}

/** Fake library: 3 good styles (alpha has poster, beta none, gamma a styleframe), _template, README.md, broken JSON. */
function fakeLibrary(): string {
  const lib = path.join(tmpDir(), 'lemo-opuscar');
  const styles = path.join(lib, 'styles');
  write(path.join(styles, 'README.md'), '# library\n');
  write(path.join(styles, '_template', 'style.json'), JSON.stringify({ slug: 'my-style', num: '', en: 'My Style' }));
  write(
    path.join(styles, 'alpha-style', 'style.json'),
    JSON.stringify({ slug: 'alpha-style', num: '10', en: 'Alpha', cn: '阿尔法', category_en: 'Cat A', category_cn: '甲' }),
  );
  write(path.join(styles, 'alpha-style', 'poster.jpg'), 'jpg');
  write(path.join(styles, 'alpha-style', 'STYLE.md'), '# alpha\n');
  write(
    path.join(styles, 'beta-style', 'style.json'),
    JSON.stringify({ slug: 'beta-style', num: '2', en: 'Beta', category_en: '' }),
  );
  write(
    path.join(styles, 'gamma', 'style.json'),
    JSON.stringify({ slug: 'gamma', num: '', en: '', category_en: 'Cat B', cn: '伽马' }),
  );
  write(path.join(styles, 'gamma', 'demo', 'stills', 'styleframe.jpg'), 'jpg');
  write(path.join(styles, 'broken-style', 'style.json'), '{oops');
  // Skipped with a reason: no style.json, non-object JSON, duplicate slug (zeta sorts after alpha-style).
  fs.mkdirSync(path.join(styles, 'no-json'), { recursive: true });
  write(path.join(styles, 'array-json', 'style.json'), '[]');
  write(path.join(styles, 'zeta-dupe', 'style.json'), JSON.stringify({ slug: 'alpha-style', en: 'Dupe' }));
  return lib;
}

const envKeys = ['CR_LEMO_FILE', 'CR_DATA_DIR', 'CR_LEMO_DIR'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of envKeys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('buildLemoStyles', () => {
  it('builds the three good styles in numeric order with the expected shape', () => {
    const lib = fakeLibrary();
    const { styles, skipped } = buildLemoStyles(lib);
    expect(styles.map((s) => s.id)).toEqual(['beta-style', 'alpha-style', 'gamma']);
    for (const s of styles) {
      expect(s.id).toMatch(SAFE_ID);
      expect(path.isAbsolute(s.stylePath)).toBe(true);
      expect(s.stylePath).not.toContain('\\');
      expect(fs.existsSync(s.stylePath)).toBe(true);
    }

    const [beta, alpha, gamma] = styles;
    expect(beta).toEqual({
      id: 'beta-style',
      name: 'Beta',
      category: 'Other',
      stylePath: slash(path.join(lib, 'styles', 'beta-style')),
      thumb: null,
    });
    expect(alpha.name).toBe('Alpha');
    expect(alpha.nameZh).toBe('阿尔法');
    expect(alpha.category).toBe('Cat A');
    expect(alpha.thumb).toBe(slash(path.join(lib, 'styles', 'alpha-style', 'poster.jpg')));
    expect(gamma.name).toBe('gamma');
    expect(gamma.nameZh).toBe('伽马');
    expect(gamma.category).toBe('Cat B');
    expect(gamma.thumb).toBe(slash(path.join(lib, 'styles', 'gamma', 'demo', 'stills', 'styleframe.jpg')));
    expect(beta).not.toHaveProperty('nameZh');

    const reasons = skipped.map((s) => path.basename(s.dir)).sort();
    expect(reasons).toEqual(['array-json', 'broken-style', 'no-json', 'zeta-dupe']);
    expect(skipped.find((s) => s.dir.endsWith('broken-style'))?.reason).toMatch(/style\.json unreadable/);
    expect(skipped.find((s) => s.dir.endsWith('no-json'))?.reason).toMatch(/missing style\.json/);
    expect(skipped.find((s) => s.dir.endsWith('array-json'))?.reason).toMatch(/not an object/);
    expect(skipped.find((s) => s.dir.endsWith('zeta-dupe'))?.reason).toMatch(/duplicate id/);
  });

  it('never throws when the library folder is missing', () => {
    const missing = path.join(tmpDir(), 'nope');
    expect(buildLemoStyles(missing)).toEqual({ styles: [], skipped: [] });
  });
});

describe('writeLemoStyles and the styles.ts round trip', () => {
  it('writes the file atomically and styles.ts reads it back', () => {
    const lib = fakeLibrary();
    const out = path.join(tmpDir(), 'nested', 'deeper', 'lemo-styles.json');
    const r = writeLemoStyles(lib, out);
    expect(r.count).toBe(3);
    expect(r.outFile).toBe(path.resolve(out));

    const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(Object.keys(doc)).toEqual(['generatedAt', 'libDir', 'styles']);
    expect(new Date(doc.generatedAt).toISOString()).toBe(doc.generatedAt);
    expect(doc.libDir).toBe(slash(path.resolve(lib)));
    expect(doc.styles).toHaveLength(3);
    expect(fs.readdirSync(path.dirname(out))).toEqual(['lemo-styles.json']);

    const list = loadLemoStyles(out);
    expect(list.installed).toBe(true);
    expect(list.error).toBeUndefined();
    expect(list.styles.map((s) => s.id)).toEqual(['beta-style', 'alpha-style', 'gamma']);
    expect(list.categories).toEqual(['Other', 'Cat A', 'Cat B']);
    expect(list.styles[1].nameZh).toBe('阿尔法');
    expect(lemoThumbFile(list.styles[1])).toBe(slash(path.join(lib, 'styles', 'alpha-style', 'poster.jpg')));
    expect(lemoThumbFile(list.styles[0])).toBeNull();

    // The array form parses too.
    expect(parseLemoStyles(JSON.stringify(doc.styles)).styles).toHaveLength(3);
  });

  it('overwrites an existing output file', () => {
    const lib = fakeLibrary();
    const out = path.join(tmpDir(), 'lemo-styles.json');
    write(out, '{"styles":[]}');
    writeLemoStyles(lib, out);
    expect(loadLemoStyles(out).styles).toHaveLength(3);
  });

  it('refuses a missing library and leaves an existing output file untouched', () => {
    const out = path.join(tmpDir(), 'lemo-styles.json');
    write(out, 'KEEP ME');
    expect(() => writeLemoStyles(path.join(tmpDir(), 'missing'), out)).toThrow(/Lemo-Opuscar library not found at/);
    expect(fs.readFileSync(out, 'utf8')).toBe('KEEP ME');
  });
});

describe('CLI main', () => {
  it('prints the count and target on success', () => {
    const lib = fakeLibrary();
    const out = path.join(tmpDir(), 'out', 'lemo-styles.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['--lib', lib, '--out', out], {})).toBe(0);
    expect(log).toHaveBeenCalledWith(`lemo-styles: 3 styles -> ${path.resolve(out)}`);
    expect(fs.existsSync(out)).toBe(true);
  });

  it('--dry-run reports the count and writes nothing', () => {
    const lib = fakeLibrary();
    const out = path.join(tmpDir(), 'out', 'lemo-styles.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['--dry-run', `--lib=${lib}`, `--out=${out}`], {})).toBe(0);
    expect(log.mock.calls[0][0]).toMatch(/^lemo-styles: 3 styles \(dry run, nothing written\)/);
    expect(fs.existsSync(path.dirname(out))).toBe(false);
  });

  it('a missing library prints one line to stderr, exits 1 and keeps the existing output file', () => {
    const out = path.join(tmpDir(), 'lemo-styles.json');
    write(out, 'KEEP ME');
    const missing = path.join(tmpDir(), 'no-lib');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['--lib', missing, '--out', out], {})).toBe(1);
    expect(err).toHaveBeenCalledWith(`Lemo-Opuscar library not found at ${missing}`);
    expect(fs.readFileSync(out, 'utf8')).toBe('KEEP ME');
  });

  it('--help prints usage and an unknown flag exits 2', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['--help'], {})).toBe(0);
    expect(log.mock.calls[0][0]).toMatch(/^Usage: node scripts\/lemo-styles\.mjs/);
    expect(main(['--bogus'], {})).toBe(2);
    expect(err.mock.calls[0][0]).toMatch(/unknown argument --bogus/);
  });
});

describe('resolveLibDir and resolveOutFile', () => {
  it('library: --lib beats CR_LEMO_DIR beats ~/lemo-opuscar', () => {
    expect(resolveLibDir({ CR_LEMO_DIR: '/env/lib' }, ['--lib', '/flag/lib'])).toBe(path.resolve('/flag/lib'));
    expect(resolveLibDir({ CR_LEMO_DIR: '/env/lib' }, ['--lib=/flag/eq'])).toBe(path.resolve('/flag/eq'));
    expect(resolveLibDir({ CR_LEMO_DIR: '/env/lib' }, [])).toBe(path.resolve('/env/lib'));
    expect(resolveLibDir({ CR_LEMO_DIR: '  ' }, [])).toBe(path.join(os.homedir(), 'lemo-opuscar'));
    expect(resolveLibDir({}, [])).toBe(path.join(os.homedir(), 'lemo-opuscar'));
  });

  it('output: --out beats CR_DATA_DIR beats ~/.claude-control-room', () => {
    const data = tmpDir();
    expect(resolveOutFile({ CR_DATA_DIR: data }, ['--out', '/flag/x.json'])).toBe(path.resolve('/flag/x.json'));
    expect(resolveOutFile({ CR_DATA_DIR: data }, [])).toBe(path.join(data, 'lemo-styles.json'));
    expect(resolveOutFile({}, [])).toBe(path.join(os.homedir(), '.claude-control-room', 'lemo-styles.json'));
  });
});

describe('defaultLemoFile precedence', () => {
  it('CR_LEMO_FILE > <dataDir>/lemo-styles.json (when present) > legacy docs file > <dataDir>/lemo-styles.json', () => {
    const data = tmpDir();
    process.env.CR_DATA_DIR = data;
    const generated = path.join(data, 'lemo-styles.json');
    const legacy = path.resolve(__dirname, '..', '..', 'docs', 'lemo-styles.json');

    // Nothing generated yet: the future location, unless a legacy file exists in the repo.
    expect(defaultLemoFile()).toBe(fs.existsSync(legacy) ? legacy : generated);

    // A generated file in the data dir wins over the legacy one.
    write(generated, '{"styles":[]}');
    expect(defaultLemoFile()).toBe(generated);

    // CR_LEMO_FILE wins over everything, even when set to a path that does not exist.
    process.env.CR_LEMO_FILE = path.join(data, 'override.json');
    expect(defaultLemoFile()).toBe(path.join(data, 'override.json'));

    // A blank CR_LEMO_FILE is ignored.
    process.env.CR_LEMO_FILE = '   ';
    expect(defaultLemoFile()).toBe(generated);
  });
});
