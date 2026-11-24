// Chat attachments, pure parts: chip state reducer, what to accept, clipboard / drop file extraction,
// pasted-image naming and the upload call. No React here (see components/useAttachments.ts).
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES, formatSize, type UploadedFile } from '../../shared/uploads';

export const ATTACH_REMOTE_TITLE = 'แนบไฟล์ได้เฉพาะงานบนเครื่องนี้';

export interface Chip {
  key: string;
  name: string;
  size: number;
  mime: string;
  status: 'uploading' | 'ready' | 'error';
  id?: string; // server upload id, once ready
  error?: string;
  previewUrl?: string; // object URL of an image, revoked by the hook
}

export type ChipAction =
  | { type: 'add'; chips: Chip[] }
  | { type: 'done'; key: string; id: string; name: string }
  | { type: 'fail'; key: string; error: string }
  | { type: 'remove'; key: string }
  | { type: 'clear' };

export function chipsReducer(state: Chip[], a: ChipAction): Chip[] {
  switch (a.type) {
    case 'add':
      return [...state, ...a.chips];
    case 'done':
      return state.map((c) => (c.key === a.key ? { ...c, status: 'ready', id: a.id, name: a.name, error: undefined } : c));
    case 'fail':
      return state.map((c) => (c.key === a.key ? { ...c, status: 'error', error: a.error } : c));
    case 'remove':
      return state.filter((c) => c.key !== a.key);
    case 'clear':
      return [];
  }
}

export const readyIds = (chips: readonly Chip[]): string[] => chips.flatMap((c) => (c.status === 'ready' && c.id ? [c.id] : []));
export const isUploading = (chips: readonly Chip[]): boolean => chips.some((c) => c.status === 'uploading');

/** Send is possible with text, with attachments, or both; never while a file is still going up. */
export function canSubmit(text: string, chips: readonly Chip[]): boolean {
  return !isUploading(chips) && (text.trim() !== '' || readyIds(chips).length > 0);
}

/**
 * Which of `files` may be added next to the chips already there. Failed chips do not count (they are not sent).
 * Returns the accepted indices and Thai problem lines for the rest.
 */
export function planAdd(existing: readonly Chip[], files: readonly { name: string; size: number }[]): { accept: number[]; problems: string[] } {
  const accept: number[] = [];
  const problems: string[] = [];
  let count = existing.filter((c) => c.status !== 'error').length;
  files.forEach((f, i) => {
    if (f.size > UPLOAD_MAX_BYTES) problems.push(`${f.name}: ไฟล์ใหญ่เกิน ${formatSize(UPLOAD_MAX_BYTES)}`);
    else if (f.size === 0) problems.push(`${f.name}: ไฟล์ว่างเปล่า`);
    else if (count >= UPLOAD_MAX_FILES) problems.push(`${f.name}: แนบได้ไม่เกิน ${UPLOAD_MAX_FILES} ไฟล์ต่อข้อความ`);
    else {
      accept.push(i);
      count += 1;
    }
  });
  return { accept, problems };
}

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

/** A screenshot pasted from the clipboard arrives as "image.png": give it a unique readable name. Real file names are kept. */
export function pastedName(file: { name: string; type: string }, now: Date, index = 0): string {
  const generic = file.name === '' || /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
  if (!generic) return file.name;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const ext = MIME_EXT[file.type] ?? 'png';
  return `screenshot-${stamp}${index > 0 ? `-${index + 1}` : ''}.${ext}`;
}

interface TransferItemLike {
  kind: string;
  getAsFile(): File | null;
}
export interface TransferLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<TransferItemLike> | null;
  types?: ArrayLike<string> | null;
}

/** Files carried by a drop or paste. `items` and `files` list the same files in Chrome, so only one is used. */
export function extractFiles(dt: TransferLike | null | undefined): File[] {
  if (!dt) return [];
  const fromItems: File[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile();
    if (f) fromItems.push(f);
  }
  return fromItems.length > 0 ? fromItems : Array.from(dt.files ?? []);
}

/** A drag that carries files (not text or a link). */
export function dragHasFiles(dt: TransferLike | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes('Files');
}

type FetchFn = (url: string, init: { method: string; body: Blob; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Uploads one file to POST /api/upload. Throws Error with a Thai message. */
export async function uploadFile(file: Blob & { name: string }, name: string, base: string, fetchFn: FetchFn = fetch as unknown as FetchFn): Promise<UploadedFile> {
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(`${base}/api/upload`, {
      method: 'POST',
      body: file,
      headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': file.type || 'application/octet-stream' },
    });
  } catch {
    throw new Error('อัปโหลดไม่สำเร็จ — เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
  }
  let body: { ok?: boolean; error?: string } & Partial<UploadedFile> = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // not JSON: handled below
  }
  if (!res.ok || body.ok !== true || typeof body.id !== 'string') throw new Error(typeof body.error === 'string' ? body.error : 'อัปโหลดไม่สำเร็จ');
  return { id: body.id, name: body.name ?? name, mime: body.mime ?? file.type, size: body.size ?? file.size };
}
