import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wideWindow, type ScreenInfo } from './wideWindow';

const scr = (x: number, y: number, w: number, h: number, taskbar = 0): ScreenInfo => ({ x, y, w, h, wx: x, wy: y, ww: w, wh: h - taskbar });

// This PC: primary \\.\DISPLAY2 at (0,0) with a 40 px taskbar, \\.\DISPLAY1 at (-1920,60); 1920x1080 each.
const THIS_PC = [scr(0, 0, 1920, 1080, 40), scr(-1920, 60, 1920, 1080)];
const THREE = [scr(1920, 0, 1920, 1080), scr(0, 0, 1920, 1080, 40), scr(3840, 0, 1280, 1024)];
const TOP_BAR: ScreenInfo[] = [{ ...scr(0, 0, 1920, 1080), wy: 40, wh: 1040 }, scr(1920, 0, 1920, 1080)];

describe('wideWindow', () => {
  it('one screen: open normally', () => {
    expect(wideWindow([scr(0, 0, 1920, 1080, 40)])).toBeNull();
    expect(wideWindow([])).toBeNull();
  });
  it('this PC: spans both, vertical intersection of the working areas, seam at the monitor boundary', () => {
    // top = max(0, 60) = 60; bottom = min(1080-40, 60+1080) = 1040
    expect(wideWindow(THIS_PC)).toEqual({ x: -1920, y: 60, w: 3840, h: 980, seams: [1920] });
  });
  it('three screens side by side: two seams, input order does not matter', () => {
    expect(wideWindow(THREE)).toEqual({ x: 0, y: 0, w: 5120, h: 1024, seams: [1920, 3840] });
  });
  it('a taskbar at the top of one screen pushes the top edge down', () => {
    expect(wideWindow(TOP_BAR)).toEqual({ x: 0, y: 40, w: 3840, h: 1040, seams: [1920] });
  });
  it('screens stacked vertically share no usable band: open normally', () => {
    expect(wideWindow([scr(0, 0, 1920, 1080), scr(0, 1080, 1920, 1080)])).toBeNull();
  });
});

// The PowerShell launcher must agree with wideWindow() (run with -DryRun: nothing is started).
const ps1 = resolve(__dirname, '../../../scripts/open-wide.ps1');
describe.skipIf(process.platform !== 'win32' || !existsSync(ps1))('open-wide.ps1 -DryRun', () => {
  const run = (screens: ScreenInfo[]): string =>
    execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Url', 'http://127.0.0.1:1/?ui=v2', '-DryRun', '-ScreensJson', JSON.stringify(screens), '-ProfileDir', 'C:\\x\\wide-profile'],
      { encoding: 'utf8' },
    ).trim();
  it.each([
    ['this PC', THIS_PC],
    ['three screens', THREE],
    ['bar at the top', TOP_BAR],
  ] as const)('%s matches the JS maths', (_name, screens) => {
    const w = wideWindow([...screens])!;
    const out = run([...screens]);
    expect(out).toContain(`--window-position=${w.x},${w.y}`);
    expect(out).toContain(`--window-size=${w.w},${w.h}`);
    expect(out).toContain(`&seams=${w.seams.join(',')}`);
  });
  it('builds the app-window command line', () => {
    const out = run(THIS_PC);
    expect(out).toMatch(/(chrome|msedge)\.exe" --app=http:\/\/127\.0\.0\.1:1\/\?ui=v2&seams=1920 /);
    expect(out).toContain('--user-data-dir=C:\\x\\wide-profile');
    expect(out).toContain('--no-first-run');
  });
  it('one screen opens the plain URL', () => {
    expect(run([scr(0, 0, 1920, 1080)])).toBe('OPEN-DEFAULT http://127.0.0.1:1/?ui=v2');
  });
});
