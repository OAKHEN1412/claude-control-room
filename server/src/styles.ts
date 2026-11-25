// Style list for Clip Studio: our five existing workflows + the Lemo-Opuscar styles read from
// lemo-styles.json (built by scripts/lemo-styles.mjs from the installed library). The file is read on server start
// and on "reload styles"; when it is missing or unreadable the Lemo section is "not installed".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './cmdlog';
import type { VarMap } from '../../shared/protocol';

export interface LemoStyle {
  id: string;
  name: string;
  nameZh?: string;
  category: string;
  stylePath: string;
  thumb: string | null; // local image path or http(s) URL
}

export interface LemoList {
  installed: boolean;
  styles: LemoStyle[];
  categories: string[]; // in first-seen order
  error?: string; // file exists but could not be used
  code?: string; // srv.* code of `error`
  vars?: VarMap; // values for the {name} placeholders of `code`
}

/**
 * Where the style list is read from, first match wins:
 *   1. CR_LEMO_FILE (when set),
 *   2. <dataDir>/lemo-styles.json when it exists (the generator's output),
 *   3. the legacy docs/lemo-styles.json next to the repo when it exists,
 *   4. <dataDir>/lemo-styles.json (the future location; missing = "not installed").
 */
export function defaultLemoFile(): string {
  const o = process.env.CR_LEMO_FILE;
  if (o && o.trim() !== '') return o;
  const generated = path.join(dataDir(), 'lemo-styles.json');
  if (fs.existsSync(generated)) return generated;
  const legacy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'lemo-styles.json');
  if (fs.existsSync(legacy)) return legacy;
  return generated;
}

const SAFE_STYLE_ID = /^[A-Za-z0-9._-]{1,80}$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Parses the JSON (an array, or { styles: [...] }) and drops rows without a usable id / name. Duplicate ids keep the first. */
export function parseLemoStyles(text: string): LemoList {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { installed: false, styles: [], categories: [], error: `lemo-styles.json อ่านไม่ได้: ${msg}`, code: 'srv.styles.readFailed', vars: { msg } };
  }
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { styles?: unknown }).styles) ? (raw as { styles: unknown[] }).styles : null;
  if (!rows) {
    return { installed: false, styles: [], categories: [], error: 'lemo-styles.json: ไม่ใช่รายการสไตล์', code: 'srv.styles.notList' };
  }
  const seen = new Set<string>();
  const styles: LemoStyle[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.name) || id;
    if (!SAFE_STYLE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const thumb = str(o.thumb);
    styles.push({
      id,
      name,
      nameZh: str(o.nameZh) || undefined,
      category: str(o.category) || 'อื่นๆ',
      stylePath: str(o.stylePath),
      thumb: thumb || null,
    });
  }
  const categories: string[] = [];
  for (const s of styles) if (!categories.includes(s.category)) categories.push(s.category);
  return { installed: styles.length > 0, styles, categories };
}

/** Reads the file; a missing file means "not installed" (no error text). */
export function loadLemoStyles(file: string = defaultLemoFile()): LemoList {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { installed: false, styles: [], categories: [] };
  }
  return parseLemoStyles(text.replace(/^﻿/, ''));
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/** Local thumbnail file for a style, only when it is an existing image file. */
export function lemoThumbFile(style: LemoStyle | undefined): string | null {
  if (!style?.thumb || /^https?:\/\//i.test(style.thumb)) return null;
  if (!IMAGE_EXT.has(path.extname(style.thumb).toLowerCase())) return null;
  try {
    return fs.statSync(style.thumb).isFile() ? style.thumb : null;
  } catch {
    return null;
  }
}

export interface LemoStyleView {
  id: string;
  name: string;
  category: string;
  thumbUrl: string | null; // server route for a local file, or the remote URL
}

export function lemoView(list: LemoList): { installed: boolean; error?: string; code?: string; vars?: VarMap; categories: string[]; styles: LemoStyleView[] } {
  return {
    installed: list.installed,
    error: list.error,
    ...(list.code ? { code: list.code } : {}),
    ...(list.vars ? { vars: list.vars } : {}),
    categories: list.categories,
    styles: list.styles.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      thumbUrl: /^https?:\/\//i.test(s.thumb ?? '') ? s.thumb : lemoThumbFile(s) ? `/api/lemo-thumb/${encodeURIComponent(s.id)}` : null,
    })),
  };
}
