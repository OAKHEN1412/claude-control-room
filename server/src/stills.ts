// Sample stills for the style cards: one frame cut from an existing render with ffmpeg, cached as a JPEG
// under ~/.claude-control-room/stills. The cache key is hash(style id + render path + size + mtime), so a new
// render of the same style makes a new still; a card with no render file has no still (the UI shows a placeholder).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './cmdlog';
import type { OurStyle } from './ourStyles';

export function stillsDir(): string {
  return path.join(dataDir(), 'stills');
}

export interface RenderFile {
  file: string;
  size: number;
  mtimeMs: number;
}

/** First candidate that exists as a regular file, with the facts that go into the cache key. */
export function findRender(candidates: string[]): RenderFile | null {
  for (const file of candidates) {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size > 0) return { file, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    } catch {
      // try the next one
    }
  }
  return null;
}

export function stillKey(styleId: string, r: RenderFile): string {
  return createHash('sha256').update(`${styleId}\n${r.file}\n${r.size}\n${r.mtimeMs}`).digest('hex').slice(0, 16);
}

export function stillFile(dir: string, styleId: string, r: RenderFile): string {
  return path.join(dir, `${styleId}-${stillKey(styleId, r)}.jpg`);
}

export type RunFfmpeg = (args: string[]) => Promise<void>;

export const runFfmpeg: RunFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { windowsHide: true, timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
  });

/** ffmpeg args for one frame at `at` seconds, 640 px wide. */
export function ffmpegArgs(input: string, output: string, at: number): string[] {
  return ['-y', '-v', 'error', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', output];
}

export interface StillResult {
  file: string | null; // path of the cached JPEG, null when there is no render or ffmpeg failed
  cached: boolean;
  error?: string;
}

/** Returns the cached still, cutting it first when missing. Tries 5 s in, then the first frame (short renders). */
export async function ensureStill(
  style: Pick<OurStyle, 'id' | 'renders'>,
  opts: { dir?: string; ffmpeg?: RunFfmpeg } = {},
): Promise<StillResult> {
  const render = findRender(style.renders);
  if (!render) return { file: null, cached: false };
  const dir = opts.dir ?? stillsDir();
  const out = stillFile(dir, style.id, render);
  try {
    if (fs.statSync(out).size > 0) return { file: out, cached: true };
  } catch {
    // not cached yet
  }
  fs.mkdirSync(dir, { recursive: true });
  const run = opts.ffmpeg ?? runFfmpeg;
  const tmp = `${out}.part.jpg`;
  let lastErr = '';
  for (const at of [5, 0]) {
    try {
      await run(ffmpegArgs(render.file, tmp, at));
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
        fs.renameSync(tmp, out);
        return { file: out, cached: false };
      }
      lastErr = 'ffmpeg wrote no frame';
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  fs.rmSync(tmp, { force: true });
  return { file: null, cached: false, error: lastErr };
}
