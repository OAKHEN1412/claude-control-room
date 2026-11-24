// Chat attachments on disk: <dataDir>/uploads/<YYYY-MM-DD>/<uuid>-<sanitized name>.
// The browser only ever knows the id; the path is rebuilt here (memory map, then a scan by uuid after a restart).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_KEEP_DAYS, sanitizeFileName, type UploadedFile } from '../../shared/uploads';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StoredUpload extends UploadedFile {
  path: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
};

export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class UploadStore {
  private readonly known = new Map<string, StoredUpload>();

  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Saves bytes; returns the public record. `mime` is only informational (the runner sniffs images itself). */
  save(rawName: string, mime: string, data: Buffer): UploadedFile {
    const id = randomUUID();
    const name = sanitizeFileName(rawName);
    const dir = path.join(this.root, localDay(this.now()));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}-${name}`);
    fs.writeFileSync(file, data);
    const m = mime.split(';')[0]?.trim().toLowerCase() ?? '';
    const rec: StoredUpload = { id, name, mime: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) ? m : 'application/octet-stream', size: data.length, path: file };
    this.known.set(id, rec);
    const { path: _p, ...pub } = rec;
    return pub;
  }

  /** id -> stored upload, or null (bad id, unknown id, file deleted). Never builds a path from the id's text. */
  resolve(id: string): StoredUpload | null {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const hit = this.known.get(id);
    if (hit) {
      if (fs.existsSync(hit.path)) return hit;
      this.known.delete(id);
      return null;
    }
    return this.scan(id);
  }

  private scan(id: string): StoredUpload | null {
    let days: string[];
    try {
      days = fs.readdirSync(this.root).filter((d) => DAY_RE.test(d));
    } catch {
      return null;
    }
    for (const day of days) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(this.root, day));
      } catch {
        continue;
      }
      const f = files.find((x) => x.startsWith(`${id}-`));
      if (!f) continue;
      const full = path.join(this.root, day, f);
      let size: number;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      const name = f.slice(id.length + 1);
      const rec: StoredUpload = { id, name, mime: MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream', size, path: full };
      this.known.set(id, rec);
      return rec;
    }
    return null;
  }

  /** Deletes day folders older than `keepDays`. Returns the folder names removed. */
  cleanup(keepDays: number = UPLOAD_KEEP_DAYS): string[] {
    const cutoff = localDay(this.now() - keepDays * 86_400_000);
    const removed: string[] = [];
    let days: string[];
    try {
      days = fs.readdirSync(this.root);
    } catch {
      return removed;
    }
    for (const d of days) {
      if (!DAY_RE.test(d) || d >= cutoff) continue;
      try {
        fs.rmSync(path.join(this.root, d), { recursive: true, force: true });
        removed.push(d);
      } catch {
        // leave it for the next start
      }
    }
    for (const [id, rec] of this.known) if (!fs.existsSync(rec.path)) this.known.delete(id);
    return removed;
  }
}
