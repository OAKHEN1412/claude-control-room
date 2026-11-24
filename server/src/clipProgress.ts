// Stage progress of a clip job, inferred from what the session shows. Stage = index into CLIP_STAGES:
//   0 บท · 1 storyboard · 2 สร้าง scene · 3 preview · 4 พร้อม render
// The stage is "the step the job has reached"; the Clips service keeps the highest value ever seen, so it never
// goes backwards when old events scroll out of the timeline.
//
// Heuristic (strongest signal first; the highest stage any rule reaches wins):
//  1. Step markers. The brief asks Claude to print `ขั้น N/5 <ชื่อ>` when it STARTS step N (1 บท, 2 storyboard,
//     3 สร้าง scene, 4 preview, 5 พร้อม render). Marker N means stage N-1.
//  2. "พร้อม render" in Claude's own text (not preceded by ยัง/ไม่) = stage 4. User messages are never read,
//     because the brief itself contains that phrase.
//  3. Files Claude wrote or edited (tool labels "เขียนไฟล์: x" / "แก้ไฟล์: x", file name only):
//       storyboard/shots/boards/storyline file       -> stage 1
//       any *.html written (scene / composition)     -> stage 2
//       script/บท/vo/narration file                  -> stage 0
//  4. Preview evidence: a command mentioning hyperframes snapshot/preview/check/lint/inspect/play, or snapshot images
//     (.png/.jpg under a snapshot folder) newer than the job start                 -> stage 3
// Copying the style's workflow files (cp / robocopy) is a Bash command, not a write label, so it does not advance
// the stage. Rules 3-4 are guesses from names; rules 1-2 are what the brief asks for and are the reliable ones.
import type { TimelineEvent } from '../../shared/protocol';

export interface ProgressInput {
  events: Pick<TimelineEvent, 'kind' | 'text'>[]; // session timeline (oldest first)
  thought?: string; // session.thought (latest assistant line / tool label)
  files?: string[]; // paths (relative, any slash) of files created after the job started
}

const MARKER_RE = /ขั้น\s*([1-5])\s*\/\s*5/g;
const READY_RE = /(?<!(?:ยัง|ไม่|อย่า|ห้าม)\s*)พร้อม\s*render/i;
const WRITE_RE = /^(?:เขียนไฟล์|แก้ไฟล์):\s*(.+)$/;
const PREVIEW_CMD_RE = /hyperframes[^|;&]*\b(?:snapshot|preview|check|lint|inspect|play)\b/i;
const SNAP_FILE_RE = /(?:^|[\\/])(?:\.media[\\/])?snap[^\\/]*[\\/].+\.(?:png|jpe?g)$|(?:^|[\\/])snapshots[\\/].+\.(?:png|jpe?g)$/i;

export function inferStage(input: ProgressInput): number {
  let stage = 0;
  const bump = (n: number) => {
    if (n > stage) stage = n;
  };
  const assistant: string[] = [];
  for (const e of input.events) {
    if (e.kind === 'user') continue; // never read the user's own words (the brief names every stage)
    const text = e.text;
    if (e.kind === 'text') assistant.push(text);
    const w = WRITE_RE.exec(text);
    if (w) {
      const name = w[1].trim();
      if (/storyboard|shots?\b|shots\.md|boards?\b|storyline/i.test(name)) bump(1);
      else if (/\.html?$/i.test(name)) bump(2);
    } else if (e.kind === 'tool' && PREVIEW_CMD_RE.test(text)) bump(3);
  }
  if (input.thought) assistant.push(input.thought);
  for (const t of assistant) {
    MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(t)) !== null) bump(Number(m[1]) - 1);
    if (READY_RE.test(t)) bump(4);
  }
  for (const f of input.files ?? []) if (SNAP_FILE_RE.test(f)) bump(3);
  return stage;
}

/** Folders never scanned for new files. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__']);

/** Relative paths of files under `root` (depth <= 4, at most 3000 entries) modified at or after `since` (ms). */
export function listNewFiles(
  root: string,
  since: number,
  fsApi: { readdirSync: typeof import('node:fs').readdirSync; statSync: typeof import('node:fs').statSync },
): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 4 || seen > 3000) return;
    let names: string[];
    try {
      names = fsApi.readdirSync(dir) as string[];
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP_DIRS.has(n)) continue;
      seen++;
      const p = `${dir}/${n}`;
      const r = rel ? `${rel}/${n}` : n;
      let st;
      try {
        st = fsApi.statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, r, depth + 1);
      else if (st.mtimeMs >= since) out.push(r);
    }
  };
  walk(root, '', 0);
  return out;
}
