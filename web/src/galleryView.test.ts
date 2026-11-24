import { describe, expect, it } from 'vitest';
import type { GalleryItem } from '../../shared/protocol';
import { filterItems, formatDuration, formatSize, projectNames } from './galleryView';

const item = (over: Partial<GalleryItem> = {}): GalleryItem => ({
  id: '0123456789abcdef', project: 'alpha', name: 'render', title: 'alpha / render', mtimeMs: 0, size: 0,
  durationSec: 60, style: '', topic: '', thumbUrl: '', videoUrl: '', ...over,
});

describe('gallery helpers', () => {
  it('formats duration as m:ss, or an em dash when unknown', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9.4)).toBe('0:09');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('formats size in MB with one decimal, GB from 1024 MB', () => {
    expect(formatSize(0)).toBe('0.0 MB');
    expect(formatSize(1048576 * 12.345)).toBe('12.3 MB');
    expect(formatSize(1048576 * 1023.9)).toBe('1023.9 MB');
    expect(formatSize(1048576 * 1024)).toBe('1.0 GB');
    expect(formatSize(1048576 * 2560)).toBe('2.5 GB');
  });

  it('lists unique project names sorted', () => {
    const items = [item({ project: 'beta' }), item({ project: 'alpha' }), item({ project: 'beta' })];
    expect(projectNames(items)).toEqual(['alpha', 'beta']);
    expect(projectNames([])).toEqual([]);
  });

  it('filters by text over title, style and topic, case-insensitively', () => {
    const items = [
      item({ title: 'Alpha / Intro', style: 'Neon', topic: 'Coffee' }),
      item({ title: 'alpha / outro', style: '', topic: 'Tea' }),
      item({ title: 'beta / clip', style: 'minimal', topic: 'Cars' }),
    ];
    expect(filterItems(items, '', '').length).toBe(3);
    expect(filterItems(items, '  ALPHA ', '').map((i) => i.title)).toEqual(['Alpha / Intro', 'alpha / outro']);
    expect(filterItems(items, 'neon', '').map((i) => i.title)).toEqual(['Alpha / Intro']);
    expect(filterItems(items, 'cars', '').map((i) => i.title)).toEqual(['beta / clip']);
    expect(filterItems(items, 'nothing', '')).toEqual([]);
  });

  it('filters by project and combines with text, keeping order', () => {
    const items = [item({ project: 'alpha', title: 'a1' }), item({ project: 'beta', title: 'b1' }), item({ project: 'alpha', title: 'a2' })];
    expect(filterItems(items, '', 'alpha').map((i) => i.title)).toEqual(['a1', 'a2']);
    expect(filterItems(items, 'a2', 'alpha').map((i) => i.title)).toEqual(['a2']);
    expect(filterItems(items, 'b1', 'alpha')).toEqual([]);
  });
});
