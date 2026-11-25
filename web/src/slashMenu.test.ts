import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '../../shared/protocol';
import { insertCommand, menuKey, moveIndex, rankCommands, shouldSubmit, slashQuery } from './slashMenu';

const c = (name: string, builtin = false): SlashCommand => ({ name, description: '', argumentHint: '', builtin });

describe('slashQuery', () => {
  it('is open only while the caret is inside the first token of a text starting with /', () => {
    expect(slashQuery('/', 1)).toBe('');
    expect(slashQuery('/com', 4)).toBe('com');
    expect(slashQuery('/com', 2)).toBe('c');
    expect(slashQuery('/compact now', 12)).toBeNull();
    expect(slashQuery('/compact now', 8)).toBe('compact');
    expect(slashQuery('hello /x', 8)).toBeNull();
    expect(slashQuery('', 0)).toBeNull();
    expect(slashQuery('/a', 0)).toBeNull();
    expect(slashQuery('/a\nb', 4)).toBeNull();
  });
});

describe('rankCommands', () => {
  const all = [c('review'), c('compact', true), c('vercel:deploy'), c('code-review'), c('Context')];
  it('puts prefix matches first, then substring, case-insensitively', () => {
    expect(rankCommands(all, 'co').map((x) => x.name)).toEqual(['compact', 'code-review', 'Context']);
    expect(rankCommands(all, 'REV').map((x) => x.name)).toEqual(['review', 'code-review']);
    expect(rankCommands(all, 'zzz')).toEqual([]);
    // an exact name beats longer names that only start with it
    expect(rankCommands([{ name: 'context-engineering', description: '', argumentHint: '', builtin: false }, { name: 'context', description: '', argumentHint: '', builtin: true }], 'context').map((x) => x.name)).toEqual(['context', 'context-engineering']);
  });
  it('empty query lists everything, capped', () => {
    expect(rankCommands(all, '')).toHaveLength(5);
    expect(rankCommands(all, '', 2)).toHaveLength(2);
  });
});

describe('insertCommand', () => {
  it('replaces the first token and adds one space', () => {
    expect(insertCommand('/com', 'compact')).toEqual({ text: '/compact ', caret: 9 });
    expect(insertCommand('/co now', 'compact')).toEqual({ text: '/compact now', caret: 9 });
    expect(insertCommand('/co\nnow', 'x')).toEqual({ text: '/x \nnow', caret: 3 });
  });
});

describe('menuKey / moveIndex / shouldSubmit', () => {
  it('maps keys', () => {
    expect(menuKey({ key: 'ArrowDown' }, 3)).toBe('down');
    expect(menuKey({ key: 'ArrowUp' }, 3)).toBe('up');
    expect(menuKey({ key: 'Enter' }, 3)).toBe('pick');
    expect(menuKey({ key: 'Tab' }, 3)).toBe('pick');
    expect(menuKey({ key: 'Escape' }, 0)).toBe('close');
    expect(menuKey({ key: 'Enter' }, 0)).toBeNull(); // nothing to pick: Enter falls through to send
    expect(menuKey({ key: 'Enter', shiftKey: true }, 3)).toBeNull();
    expect(menuKey({ key: 'a' }, 3)).toBeNull();
  });
  it('wraps', () => {
    expect(moveIndex(2, 'down', 3)).toBe(0);
    expect(moveIndex(0, 'up', 3)).toBe(2);
    expect(moveIndex(0, 'down', 0)).toBe(0);
  });
  it('submits per mode and never during IME composition', () => {
    expect(shouldSubmit({ key: 'Enter' }, 'enter')).toBe(true);
    expect(shouldSubmit({ key: 'Enter', shiftKey: true }, 'enter')).toBe(false);
    expect(shouldSubmit({ key: 'Enter', isComposing: true }, 'enter')).toBe(false);
    expect(shouldSubmit({ key: 'Enter' }, 'ctrl-enter')).toBe(false);
    expect(shouldSubmit({ key: 'Enter', ctrlKey: true }, 'ctrl-enter')).toBe(true);
    expect(shouldSubmit({ key: 'a' }, 'enter')).toBe(false);
  });
});
