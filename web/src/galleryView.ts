import type { GalleryItem } from '../../shared/protocol';

/** m:ss for a clip length, or an em dash when ffprobe could not read it. */
export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** MB with one decimal, or GB with one decimal from 1024 MB up. */
export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

/** Unique project names, sorted for the project filter. */
export function projectNames(items: GalleryItem[]): string[] {
  return [...new Set(items.map((i) => i.project))].sort((a, b) => a.localeCompare(b));
}

/**
 * Keeps items whose title, style or topic contains the text (case-insensitive),
 * and whose project matches when a project is picked ('' = all). Order is kept.
 */
export function filterItems(items: GalleryItem[], text: string, project: string): GalleryItem[] {
  const q = text.trim().toLowerCase();
  return items.filter((i) => {
    if (project && i.project !== project) return false;
    if (!q) return true;
    return i.title.toLowerCase().includes(q) || i.style.toLowerCase().includes(q) || i.topic.toLowerCase().includes(q);
  });
}
