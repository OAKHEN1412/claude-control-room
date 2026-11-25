import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  configFile,
  defaultConfig,
  effectiveExtraCwds,
  effectiveGalleryRoots,
  effectivePort,
  effectiveVideosDir,
  envOverrides,
  loadConfig,
  parseConfig,
  saveConfig,
  validateConfigPatch,
} from '../src/config';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-config-'));
  tmp.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('defaults', () => {
  it('parseConfig of an empty object gives the defaults with no warnings', () => {
    const r = parseConfig('{}');
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual({
      language: 'auto', port: null, galleryRoots: [], videosDir: null, extraCwds: [], voices: [],
      update: { check: true, channel: 'stable' },
    });
  });

  it('defaultConfig returns fresh copies that do not touch DEFAULT_CONFIG', () => {
    const a = defaultConfig();
    a.galleryRoots.push('X:/x');
    a.update.check = false;
    expect(defaultConfig().galleryRoots).toEqual([]);
    expect(defaultConfig().update.check).toBe(true);
    expect(DEFAULT_CONFIG.language).toBe('auto');
  });

  it('missing file gives defaults, exists false, no warning', () => {
    const dir = tmpDir();
    const r = loadConfig(dir);
    expect(r.exists).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.file).toBe(configFile(dir));
    expect(r.config).toEqual(defaultConfig());
  });

  it('bad JSON gives defaults plus a warning and does not throw', () => {
    const r = parseConfig('{"language": ');
    expect(r.config).toEqual(defaultConfig());
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/invalid JSON/);
  });

  it('a non-object top level gives defaults plus a warning', () => {
    const r = parseConfig('[1,2]');
    expect(r.config).toEqual(defaultConfig());
    expect(r.warnings.length).toBe(1);
  });

  it('loadConfig on a bad file gives defaults and a warning', () => {
    const dir = tmpDir();
    fs.writeFileSync(configFile(dir), '{nope', 'utf8');
    const r = loadConfig(dir);
    expect(r.exists).toBe(true);
    expect(r.config).toEqual(defaultConfig());
    expect(r.warnings.length).toBe(1);
  });

  it('loadConfig on an unreadable path (a directory) gives defaults and a warning', () => {
    const dir = tmpDir();
    fs.mkdirSync(configFile(dir));
    const r = loadConfig(dir);
    expect(r.config).toEqual(defaultConfig());
    expect(r.warnings.some((w) => /unreadable/.test(w))).toBe(true);
  });
});

describe('parseConfig field handling', () => {
  it('wrong-typed fields fall back to their defaults and name the field in a warning', () => {
    const r = parseConfig(JSON.stringify({
      language: 'xx', port: 'abc', galleryRoots: 'x', videosDir: 5, extraCwds: {}, voices: 'no',
      update: { check: 'yes', channel: 'beta' },
    }));
    expect(r.config).toEqual(defaultConfig());
    const text = r.warnings.join('\n');
    for (const field of ['language', 'port', 'galleryRoots', 'videosDir', 'extraCwds', 'voices', 'update.check', 'update.channel']) {
      expect(text).toContain(field);
    }
  });

  it('unknown keys are ignored silently', () => {
    const r = parseConfig('{"whatever": 1, "language": "th"}');
    expect(r.config.language).toBe('th');
    expect(r.warnings).toEqual([]);
  });

  it('strips a leading BOM', () => {
    const r = parseConfig('\uFEFF{"language":"en"}');
    expect(r.config.language).toBe('en');
    expect(r.warnings).toEqual([]);
  });

  it('port must be an integer 1-65535 or null', () => {
    expect(parseConfig('{"port":8790}').config.port).toBe(8790);
    expect(parseConfig('{"port":1}').config.port).toBe(1);
    expect(parseConfig('{"port":65535}').config.port).toBe(65535);
    expect(parseConfig('{"port":null}').config.port).toBeNull();
    for (const bad of [0, 65536, 1.5, -3, '8790']) {
      const r = parseConfig(JSON.stringify({ port: bad }));
      expect(r.config.port).toBeNull();
      expect(r.warnings.length).toBe(1);
    }
  });

  it('path lists drop invalid entries, cap at 50, and reject over-long strings', () => {
    const long = 'a'.repeat(501);
    const r = parseConfig(JSON.stringify({ galleryRoots: ['C:/ok', '', '   ', long, 7] }));
    expect(r.config.galleryRoots).toEqual(['C:/ok']);
    expect(r.warnings.some((w) => w.includes('galleryRoots'))).toBe(true);

    const many = Array.from({ length: 60 }, (_, i) => `D:/p${i}`);
    const r2 = parseConfig(JSON.stringify({ extraCwds: many }));
    expect(r2.config.extraCwds.length).toBe(50);
    expect(r2.warnings.some((w) => w.includes('extraCwds'))).toBe(true);
  });

  it('videosDir accepts a path or null', () => {
    expect(parseConfig('{"videosDir":"E:/videos"}').config.videosDir).toBe('E:/videos');
    expect(parseConfig('{"videosDir":null}').config.videosDir).toBeNull();
  });

  it('voices: invalid ids and names dropped, duplicate ids dropped, cap at 50', () => {
    const voices = [
      { id: 'abcdefgh', name: 'Good one' },
      { id: 'abcdefgh', name: 'Duplicate' },
      { id: 'short', name: 'Too short id' },
      { id: 'bad-chars-here', name: 'Dash id' },
      { id: 'validvoice1', name: '' },
      { id: 'validvoice2', name: 'x'.repeat(81) },
      { id: 'validvoice3', name: 'Ok name' },
    ];
    const r = parseConfig(JSON.stringify({ voices }));
    expect(r.config.voices).toEqual([{ id: 'abcdefgh', name: 'Good one' }, { id: 'validvoice3', name: 'Ok name' }]);
    expect(r.warnings.join('\n')).toMatch(/voices/);

    const many = Array.from({ length: 55 }, (_, i) => ({ id: `voice${String(i).padStart(4, '0')}`, name: `V${i}` }));
    const r2 = parseConfig(JSON.stringify({ voices: many }));
    expect(r2.config.voices.length).toBe(50);
  });

  it('update.check and update.channel accept their valid values', () => {
    const r = parseConfig('{"update":{"check":false,"channel":"stable"}}');
    expect(r.config.update).toEqual({ check: false, channel: 'stable' });
    expect(r.warnings).toEqual([]);
  });
});

describe('validateConfigPatch', () => {
  it('accepts a valid partial patch', () => {
    const r = validateConfigPatch({ language: 'en', port: 9000, update: { check: false } });
    expect(r).toEqual({ ok: true, patch: { language: 'en', port: 9000, update: { check: false } } });
  });

  it('rejects unknown top-level keys', () => {
    const r = validateConfigPatch({ language: 'en', hackerKey: 'x' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown keys inside update', () => {
    const r = validateConfigPatch({ update: { check: true, auto: true } });
    expect(r.ok).toBe(false);
  });

  it('rejects wrong types and bad values', () => {
    const bad: unknown[] = [
      { language: 'fr' },
      { port: 0 },
      { port: '8790' },
      { galleryRoots: 'C:/x' },
      { galleryRoots: [1] },
      { extraCwds: Array.from({ length: 51 }, (_, i) => `D:/${i}`) },
      { videosDir: '' },
      { voices: [{ id: 'short', name: 'x' }] },
      { voices: [{ id: 'abcdefgh', name: 'a' }, { id: 'abcdefgh', name: 'b' }] },
      { update: { check: 'yes' } },
      { update: { channel: 'beta' } },
      { update: 'x' },
    ];
    for (const b of bad) expect(validateConfigPatch(b).ok, JSON.stringify(b)).toBe(false);
  });

  it('rejects non-object bodies', () => {
    expect(validateConfigPatch(null).ok).toBe(false);
    expect(validateConfigPatch([]).ok).toBe(false);
    expect(validateConfigPatch('x').ok).toBe(false);
  });

  it('accepts an empty object as a no-op patch', () => {
    expect(validateConfigPatch({})).toEqual({ ok: true, patch: {} });
  });
});

describe('saveConfig', () => {
  it('creates the directory, writes the file atomically, and merges patches', () => {
    const base = path.join(tmpDir(), 'nested', 'data');
    const first = saveConfig({ language: 'en', update: { check: false } }, base);
    expect(first.language).toBe('en');
    expect(first.update).toEqual({ check: false, channel: 'stable' });
    expect(fs.existsSync(configFile(base))).toBe(true);

    const second = saveConfig({ port: 9100, update: { channel: 'stable' } }, base);
    expect(second.language).toBe('en');
    expect(second.port).toBe(9100);
    expect(second.update).toEqual({ check: false, channel: 'stable' });

    const onDisk = JSON.parse(fs.readFileSync(configFile(base), 'utf8'));
    expect(onDisk.language).toBe('en');
    expect(onDisk.port).toBe(9100);
    expect(onDisk.update.check).toBe(false);

    // no temp files left behind
    expect(fs.readdirSync(base).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(loadConfig(base).exists).toBe(true);
  });

  it('a patch with explicit null clears port and videosDir', () => {
    const dir = tmpDir();
    saveConfig({ port: 9000, videosDir: 'E:/v' }, dir);
    const c = saveConfig({ port: null, videosDir: null }, dir);
    expect(c.port).toBeNull();
    expect(c.videosDir).toBeNull();
  });
});

describe('env-wins helpers', () => {
  const cfg = () => ({ ...defaultConfig(), port: 9001, galleryRoots: ['F:/g'], videosDir: 'F:/v', extraCwds: ['G:/a', 'G:/b'] });

  it('effectivePort: CR_PORT, then PORT, then config, then fallback', () => {
    expect(effectivePort({ CR_PORT: '9100', PORT: '9200' }, cfg(), 8790)).toBe(9100);
    expect(effectivePort({ PORT: '9200' }, cfg(), 8790)).toBe(9200);
    expect(effectivePort({ CR_PORT: 'junk' }, cfg(), 8790)).toBe(9001);
    expect(effectivePort({}, defaultConfig(), 8790)).toBe(8790);
  });

  it('effectiveGalleryRoots: env wins, then config, then ~/videos', () => {
    const delim = path.delimiter;
    expect(effectiveGalleryRoots({ CR_GALLERY_ROOTS: ['H:/x', 'H:/y'].join(delim) }, cfg())).toEqual(['H:/x', 'H:/y']);
    expect(effectiveGalleryRoots({}, cfg())).toEqual(['F:/g']);
    expect(effectiveGalleryRoots({}, defaultConfig())).toEqual([path.join(os.homedir(), 'videos')]);
  });

  it('effectiveVideosDir: env, then config, then ~/videos', () => {
    expect(effectiveVideosDir({ CR_VIDEOS_DIR: 'Z:/vid' }, cfg())).toBe('Z:/vid');
    expect(effectiveVideosDir({}, cfg())).toBe('F:/v');
    expect(effectiveVideosDir({}, defaultConfig())).toBe(path.join(os.homedir(), 'videos'));
  });

  it('effectiveExtraCwds: de-duplicated union, env first', () => {
    const env = { CR_EXTRA_CWDS: ['G:/b', 'K:/k'].join(path.delimiter) };
    expect(effectiveExtraCwds(env, cfg())).toEqual(['G:/b', 'K:/k', 'G:/a']);
    expect(effectiveExtraCwds({}, defaultConfig())).toEqual([]);
  });

  it('envOverrides reports which env vars are set without returning values', () => {
    expect(envOverrides({})).toEqual({ port: false, galleryRoots: false, videosDir: false, extraCwds: false });
    expect(envOverrides({ PORT: '9000', CR_VIDEOS_DIR: 'Q:/v', CR_EXTRA_CWDS: '   ' })).toEqual({
      port: true, galleryRoots: false, videosDir: true, extraCwds: false,
    });
  });
});
