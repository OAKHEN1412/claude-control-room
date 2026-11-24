// Builds the stream-json user message content for a send / start with attachments.
// Images (png/jpeg/gif/webp, <= 5 MB, recognised by their first bytes) become an image block AND a path line;
// every other file (or a bigger image) is only a "[ไฟล์แนบ] <path>" line so Claude can Read it.
import fs from 'node:fs';
import { INLINE_IMAGE_MAX_BYTES, attachLine } from '../../shared/uploads';
import type { StoredUpload } from './uploads';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type UserContent = string | ContentBlock[];

/** image mime from the file's first bytes, or null when it is not one of the four formats the API takes. */
export function sniffImageMime(b: Buffer): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8' && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** No attachments: the plain string (unchanged behaviour). Otherwise one array: image blocks first, then ONE text block. */
export function buildUserContent(
  text: string,
  atts: readonly StoredUpload[],
  readFile: (p: string) => Buffer = (p) => fs.readFileSync(p),
): UserContent {
  if (atts.length === 0) return text;
  const images: ContentBlock[] = [];
  const lines: string[] = [];
  for (const a of atts) {
    lines.push(attachLine(a.path));
    if (a.size > INLINE_IMAGE_MAX_BYTES) continue;
    let buf: Buffer;
    try {
      buf = readFile(a.path);
    } catch {
      continue; // unreadable: the path line is still there
    }
    if (buf.length > INLINE_IMAGE_MAX_BYTES) continue;
    const mime = sniffImageMime(buf);
    if (mime) images.push({ type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } });
  }
  const body = [text.trim() === '' ? '' : text, ...lines].filter((s) => s !== '').join('\n');
  return [...images, { type: 'text', text: body }];
}
