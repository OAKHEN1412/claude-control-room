// Chat attachments: constants and pure helpers shared by the server (upload route, runner, parser) and the web.
// Kept out of protocol.ts on purpose (other branches edit that file).

export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // per file
export const UPLOAD_MAX_FILES = 10; // per message
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // larger images are only passed as a path
export const UPLOAD_KEEP_DAYS = 14;

/** What POST /api/upload answers (inside {ok:true, ...}). The client only ever sends `id` back. */
export interface UploadedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Marker of the text line the runner writes for every attachment; the parser turns it into "📎 name". */
export const ATTACH_MARK = '[ไฟล์แนบ]';
const ATTACH_LINE_RE = /^\[ไฟล์แนบ\] (.+)$/gm;
const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/;

export function attachLine(filePath: string): string {
  return `${ATTACH_MARK} ${filePath}`;
}

/** Display name of a saved upload path: base name without the uuid prefix. */
export function attachDisplayName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(UUID_PREFIX_RE, '');
}

/** Replaces every "[ไฟล์แนบ] <path>" line with "📎 <name>" (timeline, titles). Text without such lines is returned as is. */
export function showAttachments(text: string): string {
  if (!text.includes(ATTACH_MARK)) return text;
  return text.replace(ATTACH_LINE_RE, (_m, p: string) => `📎 ${attachDisplayName(p.trim())}`);
}

const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
export const NAME_MAX = 100;

/**
 * Makes a client-supplied file name safe to use as the tail of a path on Windows: no folders, no control
 * characters or <>:"|?*, no trailing dots/spaces, no reserved device names, length capped (extension kept).
 * Thai letters are kept.
 */
export function sanitizeFileName(raw: string): string {
  let n = String(raw ?? '');
  n = n.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  n = n.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  const dot = n.lastIndexOf('.');
  let stem = dot > 0 ? n.slice(0, dot) : n;
  let ext = dot > 0 ? n.slice(dot) : '';
  if (ext.length > 16) ext = ext.slice(0, 16);
  stem = stem.replace(/[\s.]+$/, '');
  if (stem === '') stem = 'file';
  else if (RESERVED_RE.test(stem)) stem = `_${stem}`;
  if (stem.length + ext.length > NAME_MAX) stem = Array.from(stem).slice(0, Math.max(1, NAME_MAX - ext.length)).join('');
  return `${stem}${ext}`;
}

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(mime);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
