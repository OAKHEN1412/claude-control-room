// Window geometry for "one app window across every monitor". The launcher scripts/open-wide.ps1 does the same maths in
// PowerShell (Get-WideWindow); wideWindow.test.ts runs both on the same screens so they cannot drift apart.

export interface ScreenInfo {
  /** Full bounds. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Working area (taskbar excluded). */
  wx: number;
  wy: number;
  ww: number;
  wh: number;
}

export interface WideWindow {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Client-x of every monitor boundary inside the window. */
  seams: number[];
}

/**
 * Horizontal union of all screens, vertical intersection of their working areas; seams where each further screen
 * starts. null for one screen, or when the screens share no usable vertical band (stacked layouts): open normally.
 */
export function wideWindow(screens: readonly ScreenInfo[]): WideWindow | null {
  if (screens.length < 2) return null;
  const sorted = [...screens].sort((a, b) => a.x - b.x);
  const left = Math.min(...sorted.map((s) => s.x));
  const right = Math.max(...sorted.map((s) => s.x + s.w));
  const top = Math.max(...sorted.map((s) => s.wy));
  const bottom = Math.min(...sorted.map((s) => s.wy + s.wh));
  if (bottom - top < 300 || right - left < 600) return null;
  const seams: number[] = [];
  for (const s of sorted) {
    const cx = s.x - left;
    if (cx > 0 && cx < right - left && !seams.includes(cx)) seams.push(cx);
  }
  return { x: left, y: top, w: right - left, h: bottom - top, seams };
}
