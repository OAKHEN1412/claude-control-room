// Builds the Lemo-Opuscar style list (read by server/src/styles.ts) from the installed library.
// Usage: node scripts/lemo-styles.mjs [--lib <dir>] [--out <file>] [--dry-run] [--help]
// Library dir: --lib > CR_LEMO_DIR > ~/lemo-opuscar. Output: --out > <CR_DATA_DIR or ~/.claude-control-room>/lemo-styles.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;
const IMAGE_CANDIDATES = ['poster.jpg', path.join('demo', 'stills', 'styleframe.jpg')];

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function slash(p) {
  return p.split(path.sep).join('/');
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Numeric sort key for `num`; empty or non-numeric values sort last. */
function numKey(num) {
  return /^\d+(\.\d+)?$/.test(num) ? Number(num) : Infinity;
}

/** Builds { styles, skipped } from `<libDir>/styles`. Never throws for bad style folders. */
export function buildLemoStyles(libDir) {
  const root = path.resolve(libDir);
  const stylesDir = path.join(root, 'styles');
  const styles = [];
  const skipped = [];
  if (!isDir(stylesDir)) return { styles, skipped };

  let entries;
  try {
    entries = fs.readdirSync(stylesDir, { withFileTypes: true });
  } catch (e) {
    return { styles, skipped: [{ dir: stylesDir, reason: `cannot read styles folder: ${e.message}` }] };
  }

  const seen = new Set();
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('_') || ent.name.startsWith('.')) continue;
    if (!ent.isDirectory()) continue;
    const dir = path.join(stylesDir, ent.name);

    const jsonPath = path.join(dir, 'style.json');
    let meta;
    try {
      if (!isFile(jsonPath)) throw new Error('missing style.json');
      meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^﻿/, ''));
    } catch (e) {
      skipped.push({ dir, reason: `style.json unreadable: ${e.message}` });
      continue;
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      skipped.push({ dir, reason: 'style.json is not an object' });
      continue;
    }

    const id = str(meta.slug) || ent.name;
    if (!SAFE_ID.test(id)) {
      skipped.push({ dir, reason: `invalid id "${id}"` });
      continue;
    }
    if (seen.has(id)) {
      skipped.push({ dir, reason: `duplicate id "${id}"` });
      continue;
    }
    seen.add(id);

    const thumbFile = IMAGE_CANDIDATES.map((rel) => path.join(dir, rel)).find(isFile);
    const style = {
      id,
      name: str(meta.en) || id,
      category: str(meta.category_en) || 'Other',
      stylePath: slash(dir),
      thumb: thumbFile ? slash(thumbFile) : null,
    };
    const nameZh = str(meta.cn);
    if (nameZh) style.nameZh = nameZh;
    styles.push({ style, num: str(meta.num) });
  }

  styles.sort((a, b) => {
    const ka = numKey(a.num);
    const kb = numKey(b.num);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.style.id < b.style.id ? -1 : a.style.id > b.style.id ? 1 : 0;
  });
  return { styles: styles.map((x) => x.style), skipped };
}

/** True when the library folder has a styles/ subfolder. */
export function isLemoLibrary(libDir) {
  return isDir(path.join(path.resolve(libDir), 'styles'));
}

/** Parses the generator's own flags (--lib, --out, --dry-run, --help); both `--flag value` and `--flag=value` work. */
export function parseLemoArgs(argv = []) {
  const out = { lib: undefined, out: undefined, dryRun: false, help: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const take = () => {
      if (inline !== undefined) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return undefined;
      i++;
      return v;
    };
    if (name === '--lib') out.lib = take();
    else if (name === '--out') out.out = take();
    else if (name === '--dry-run') out.dryRun = true;
    else if (name === '--help' || name === '-h') out.help = true;
    else out.unknown.push(a);
  }
  return out;
}

/** Library dir: --lib > CR_LEMO_DIR > ~/lemo-opuscar. */
export function resolveLibDir(env = process.env, argv = []) {
  const flag = parseLemoArgs(argv).lib;
  if (flag && flag.trim() !== '') return path.resolve(flag);
  const e = env.CR_LEMO_DIR;
  if (e && e.trim() !== '') return path.resolve(e);
  return path.join(os.homedir(), 'lemo-opuscar');
}

/** Output file: --out > <CR_DATA_DIR or ~/.claude-control-room>/lemo-styles.json. */
export function resolveOutFile(env = process.env, argv = []) {
  const flag = parseLemoArgs(argv).out;
  if (flag && flag.trim() !== '') return path.resolve(flag);
  const d = env.CR_DATA_DIR;
  const dataDir = d && d.trim() !== '' ? d : path.join(os.homedir(), '.claude-control-room');
  return path.join(dataDir, 'lemo-styles.json');
}

/** Builds the list and writes it atomically (tmp file + rename). Throws when the library has no styles/ folder. */
export function writeLemoStyles(libDir, outFile) {
  const root = path.resolve(libDir);
  if (!isLemoLibrary(root)) throw new Error(`Lemo-Opuscar library not found at ${root}`);
  const { styles, skipped } = buildLemoStyles(root);
  const doc = { generatedAt: new Date().toISOString(), libDir: slash(root), styles };
  const target = path.resolve(outFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return { count: styles.length, outFile: target, skipped };
}

const USAGE = `Usage: node scripts/lemo-styles.mjs [--lib <dir>] [--out <file>] [--dry-run] [--help]

Builds the Lemo-Opuscar style list for Clip Studio from the installed library.
  --lib <dir>   library folder (default: CR_LEMO_DIR, else ~/lemo-opuscar)
  --out <file>  output file (default: <CR_DATA_DIR or ~/.claude-control-room>/lemo-styles.json)
  --dry-run     count the styles and print the target; writes nothing
  --help        show this text`;

/** CLI entry. Returns the exit code. */
export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseLemoArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.unknown.length > 0) {
    console.error(`lemo-styles: unknown argument ${args.unknown[0]}\n${USAGE}`);
    return 2;
  }
  const lib = resolveLibDir(env, argv);
  if (!isLemoLibrary(lib)) {
    console.error(`Lemo-Opuscar library not found at ${lib}`);
    return 1;
  }
  const outFile = resolveOutFile(env, argv);
  try {
    if (args.dryRun) {
      const { styles, skipped } = buildLemoStyles(lib);
      console.log(`lemo-styles: ${styles.length} styles (dry run, nothing written) -> ${outFile}`);
      for (const s of skipped) console.error(`  skipped ${s.dir}: ${s.reason}`);
      return 0;
    }
    const { count, skipped } = writeLemoStyles(lib, outFile);
    console.log(`lemo-styles: ${count} styles -> ${outFile}`);
    for (const s of skipped) console.error(`  skipped ${s.dir}: ${s.reason}`);
    return 0;
  } catch (e) {
    console.error(`lemo-styles: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = path.resolve(fileURLToPath(import.meta.url));
  const given = path.resolve(entry);
  return process.platform === 'win32' ? self.toLowerCase() === given.toLowerCase() : self === given;
}

if (isMain()) {
  process.exitCode = main();
}
