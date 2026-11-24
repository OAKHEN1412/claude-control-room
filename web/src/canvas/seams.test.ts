import { describe, expect, it } from 'vitest';
import { allBoxes, layoutCanvas, unionBox, type Box } from './canvasLayout';
import { PANE_H, PANE_W, type PaneNode } from './paneStore';
import { relayoutPanes } from './placement';
import { SEAM_BAND, SEAM_MARGIN, findFreeSpotAvoiding, lastMonitorStart, leftMonitorInset, monitorAt, monitorSpans, nudgeCentre, parseSeams, seamBandsWorld, snapRectToMonitor } from './seams';
import { fitView } from './viewport';

describe('parseSeams', () => {
  it('reads one or several integers inside the window, sorted and unique', () => {
    expect(parseSeams('?ui=v2&seams=1920', 3840)).toEqual([1920]);
    expect(parseSeams('?seams=3840,1920,1920', 5761)).toEqual([1920, 3840]);
  });
  it('drops anything invalid and ignores the rest', () => {
    expect(parseSeams('?seams=0,3840,4000,-5,1.5,abc,1e3,1920', 3840)).toEqual([1920]);
    expect(parseSeams('?ui=v2', 3840)).toEqual([]);
    expect(parseSeams('?seams=', 3840)).toEqual([]);
    expect(parseSeams('?seams=1920', 0)).toEqual([]);
    expect(parseSeams('?seams=abc', 3840)).toEqual([]);
  });
});

describe('monitors', () => {
  it('cuts the window at the seams', () => {
    expect(monitorSpans([], 1000)).toEqual([{ x: 0, w: 1000 }]);
    expect(monitorSpans([1920], 3840)).toEqual([
      { x: 0, w: 1920 },
      { x: 1920, w: 1920 },
    ]);
    expect(monitorSpans([1000, 2500], 3000).map((s) => s.w)).toEqual([1000, 1500, 500]);
  });
  it('finds the monitor under x', () => {
    const sp = monitorSpans([1920], 3840);
    expect([monitorAt(sp, 0), monitorAt(sp, 1919), monitorAt(sp, 1920), monitorAt(sp, 9999)]).toEqual([0, 0, 1, 1]);
  });
});

describe('seam bands in world coordinates', () => {
  it('converts the band with the current pan and zoom', () => {
    const [b] = seamBandsWorld([1920], { x: 100, y: 0, k: 2 });
    expect(b.x * 2 + 100).toBe(1920 - SEAM_BAND);
    expect((b.x + b.w) * 2 + 100).toBe(1920 + SEAM_BAND);
  });
  it('is narrower in world units when zoomed in', () => {
    expect(seamBandsWorld([1920], { x: 0, y: 0, k: 2 })[0].w).toBe(SEAM_BAND);
    expect(seamBandsWorld([1920], { x: 0, y: 0, k: 0.5 })[0].w).toBe(SEAM_BAND * 4);
  });
  it('starts new panes just inside the last monitor', () => {
    const v = { x: -300, y: 20, k: 0.5 };
    const p = lastMonitorStart([1920], v);
    expect(p.x * v.k + v.x).toBe(1920 + SEAM_BAND + SEAM_MARGIN);
  });
});

describe('findFreeSpotAvoiding', () => {
  const size = { w: 400, h: 300 };
  const bands: Box[] = seamBandsWorld([1920], { x: 0, y: 0, k: 1 });
  it('is the plain search without bands', () => {
    expect(findFreeSpotAvoiding(size, { x: 10, y: 20 }, [], [])).toEqual({ x: 10, y: 20 });
  });
  it('moves a box that would cross a seam to the nearest side', () => {
    const left = findFreeSpotAvoiding(size, { x: 1700, y: 50 }, [], bands);
    expect(left.x + size.w).toBeLessThanOrEqual(1920 - SEAM_BAND);
    const right = findFreeSpotAvoiding(size, { x: 1900, y: 50 }, [], bands);
    expect(right.x).toBeGreaterThanOrEqual(1920 + SEAM_BAND);
  });
  it('leaves a box that is already clear of the band', () => {
    expect(findFreeSpotAvoiding(size, { x: 2000, y: 50 }, [], bands)).toEqual({ x: 2000, y: 50 });
  });
  it('still avoids obstacles', () => {
    const o: Box[] = [{ x: 1990, y: 0, w: 500, h: 200 }];
    const s = findFreeSpotAvoiding(size, { x: 2000, y: 10 }, o, bands);
    expect(s.x).toBeGreaterThanOrEqual(1920 + SEAM_BAND);
    const hit = s.x < 2490 && 1990 < s.x + size.w && s.y < 200 && 0 < s.y + size.h;
    expect(hit).toBe(false);
  });
});

describe('nudgeCentre / snapRectToMonitor', () => {
  it('does nothing without seams or when clear of them', () => {
    expect(nudgeCentre(1900, 300, [], 3840)).toBe(1900);
    expect(nudgeCentre(1000, 300, [1920], 3840)).toBe(1000);
  });
  it('moves a popup that crosses a seam onto the monitor holding its centre', () => {
    expect(nudgeCentre(1900, 300, [1920], 3840) + 150).toBeLessThanOrEqual(1920 - SEAM_MARGIN);
    expect(nudgeCentre(1930, 300, [1920], 3840) - 150).toBeGreaterThanOrEqual(1920 + SEAM_MARGIN);
  });
  it('keeps a percent widget rect on one monitor', () => {
    const r = { x: 40, y: 0, w: 30, h: 50 }; // 1536..2688 of 3840
    const s = snapRectToMonitor(r, [1920], 3840);
    const x0 = (s.x / 100) * 3840;
    const x1 = x0 + (s.w / 100) * 3840;
    expect(x0 >= 1920 || x1 <= 1920).toBe(true);
    expect(s.y).toBe(0);
    const ok = { x: 50, y: 0, w: 25, h: 100 };
    expect(snapRectToMonitor(ok, [1920], 3840)).toBe(ok);
    expect(snapRectToMonitor(r, [], 3840)).toBe(r);
  });
});

describe('fit into the left monitor', () => {
  const sessions = [
    { sessionId: 'a', subagents: [] },
    { sessionId: 'b', subagents: [] },
    { sessionId: 'c', subagents: [] },
  ];
  it('keeps the graph inside the left monitor, at the zoom a one-monitor window of that width would give', () => {
    const bounds = unionBox(allBoxes(layoutCanvas(sessions, { now: 1 })));
    const size = { w: 3840, h: 972 };
    const v = fitView(bounds, size, { insetRight: leftMonitorInset([1920], size.w), padTop: 40, padBottom: 40 });
    expect(bounds.x * v.k + v.x).toBeGreaterThanOrEqual(0);
    expect((bounds.x + bounds.w) * v.k + v.x).toBeLessThanOrEqual(1920 - SEAM_BAND);
    expect(v).toEqual(fitView(bounds, { w: 1920, h: 972 }, { padTop: 40, padBottom: 40 }));
    expect(leftMonitorInset([], 3840)).toBe(0);
  });
  it('relayoutPanes puts connected panes on the last monitor, off the seam', () => {
    const lay = layoutCanvas([{ sessionId: 'a', subagents: [] }], { now: 1 });
    const v = { x: 0, y: 0, k: 1 };
    const mk = (id: string): PaneNode => ({ id, x: 0, y: 0, w: PANE_W, h: PANE_H, source: { sessionId: 'a', agentId: null } }) as PaneNode;
    const out = relayoutPanes([mk('p1'), mk('p2')], lay, { start: lastMonitorStart([1920], v), bands: seamBandsWorld([1920], v) });
    for (const p of out) expect(p.x).toBeGreaterThanOrEqual(1920 + SEAM_BAND);
    expect(out[0].x === out[1].x && out[0].y === out[1].y).toBe(false);
  });
});
