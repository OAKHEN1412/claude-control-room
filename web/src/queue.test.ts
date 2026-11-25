import { describe, expect, it } from 'vitest';
import type { PendingRequest, RunnerState, SessionInfo, WaitItem } from '../../shared/protocol';
import {
  EMPTY_QUEUE,
  boxesOverlap,
  choosePlacement,
  collectItems,
  countText,
  labelHead,
  notificationText,
  optionLetter,
  recommendedIndex,
  shortModel,
  titleWithCount,
  updateQueue,
} from './queue';

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: id,
    pid: 1,
    name: `name-${id}`,
    cwd: 'C:\\Users\\you\\proj',
    kind: 'interactive',
    title: `Job ${id}`,
    model: 'claude-haiku-5-5',
    effort: 'high',
    status: 'waiting',
    thought: '',
    startedAt: 0,
    lastActivity: 0,
    timeline: [],
    subagents: [],
    ...over,
  };
}

const ask = (q = 'Which colour?'): PendingRequest => ({
  requestId: 'req-ask',
  toolUseId: 'tu1',
  toolName: 'AskUserQuestion',
  kind: 'ask',
  description: 'ask',
  inputPreview: '{}',
  questions: [{ question: q, header: 'h', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }],
  at: 1000,
});

const perm = (at = 2000): PendingRequest => ({
  requestId: 'req-w',
  toolUseId: 'tu2',
  toolName: 'Write',
  kind: 'permission',
  description: 'ok.txt',
  label: 'เขียนไฟล์: ok.txt',
  detail: 'ok.txt',
  inputPreview: '{"file_path":"ok.txt"}',
  at,
});

function runner(id: string, pending: PendingRequest[], over: Partial<RunnerState> = {}): RunnerState {
  return {
    sessionId: id,
    cwd: 'C:\\Users\\you\\proj',
    alive: true,
    pid: 9,
    busy: true,
    queued: 0,
    model: 'haiku',
    effort: 'low',
    confirmed: true,
    permissionMode: 'default',
    remoteControl: false,
    pending,
    startedAt: 0,
    ...over,
  };
}

const waitAsk: WaitItem = {
  id: 'tool-1',
  kind: 'ask',
  toolName: 'AskUserQuestion',
  label: 'ถามคุณ: Pick one',
  detail: 'Pick one',
  questions: [{ question: 'Pick one', header: '', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: '' }] }],
  at: 500,
};

describe('collectItems (payload mapping)', () => {
  it('maps runner pending requests to answerable items with Thai label and key detail', () => {
    const items = collectItems([session('s1')], { s1: runner('s1', [ask(), perm()]) });
    expect(items).toHaveLength(2);
    const w = items.find((i) => i.kind === 'permission')!;
    expect(w).toMatchObject({ source: 'runner', requestId: 'req-w', label: 'เขียนไฟล์: ok.txt', detail: 'ok.txt', text: 'ขออนุญาตเขียนไฟล์', job: 'Job s1', model: 'Haiku' });
    const a = items.find((i) => i.kind === 'ask')!;
    expect(a).toMatchObject({ source: 'runner', text: 'Which colour?' });
    expect(a.questions[0].options.map((o) => o.label)).toEqual(['Red', 'Blue']);
  });

  it('maps terminal wait items to read-only items (no requestId)', () => {
    const items = collectItems([session('t1', { waitItems: [waitAsk] })], {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'terminal', requestId: null, kind: 'ask', text: 'Pick one', at: 500, key: 't:t1:tool-1' });
  });

  it('a web-controlled session is represented by its Runner only (no duplicate from the watcher)', () => {
    const s = session('s1', { waitItems: [waitAsk] });
    const items = collectItems([s], { s1: runner('s1', [ask()]) });
    expect(items.map((i) => i.source)).toEqual(['runner']);
  });

  it('ignores finished sessions and dead runners', () => {
    const done = session('d', { status: 'done', waitItems: [waitAsk] });
    expect(collectItems([done], { x: runner('x', [ask()], { alive: false }) })).toEqual([]);
  });

  it('falls back to the folder name when the runner has no watcher session yet', () => {
    const [it] = collectItems([], { s9: runner('s9', [perm()]) });
    expect(it.job).toBe('…\\you\\proj');
  });
});

describe('updateQueue (reducer)', () => {
  it('adds new items, oldest first, and reports them as added', () => {
    const items = collectItems([session('s1'), session('t1', { waitItems: [waitAsk] })], { s1: runner('s1', [perm(2000), ask()]) });
    const q = updateQueue(EMPTY_QUEUE, items);
    expect(q.items.map((i) => i.at)).toEqual([500, 1000, 2000]);
    expect(q.added).toHaveLength(3);
  });

  it('keeps the same state object when nothing changed', () => {
    const items = collectItems([session('s1')], { s1: runner('s1', [ask()]) });
    const q1 = updateQueue(EMPTY_QUEUE, items);
    const q2 = updateQueue(q1, items);
    const q3 = updateQueue(q2, items);
    expect(q3).toBe(q2);
    expect(q3.added).toEqual([]);
  });

  it('an item answered elsewhere (pane / terminal) disappears at once; the others stay in order', () => {
    const s = session('s1');
    const q1 = updateQueue(EMPTY_QUEUE, collectItems([s], { s1: runner('s1', [ask(), perm()]) }));
    expect(q1.items).toHaveLength(2);
    const q2 = updateQueue(q1, collectItems([s], { s1: runner('s1', [perm()]) }));
    expect(q2.items.map((i) => i.kind)).toEqual(['permission']);
    expect(q2.added).toEqual([]);
    const t = session('t1', { waitItems: [waitAsk] });
    const q3 = updateQueue(q2, collectItems([s, t], { s1: runner('s1', [perm()]) }));
    expect(q3.items.map((i) => i.source)).toEqual(['terminal', 'runner']);
    const q4 = updateQueue(q3, collectItems([s, { ...t, waitItems: [] }], { s1: runner('s1', [perm()]) })); // answered in the terminal
    expect(q4.items.map((i) => i.source)).toEqual(['runner']);
    expect(updateQueue(q4, []).items).toEqual([]);
  });

  it('a terminal item stays read-only through every update', () => {
    const q = updateQueue(EMPTY_QUEUE, collectItems([session('t1', { waitItems: [waitAsk] })], {}));
    expect(q.items[0].requestId).toBeNull();
    expect(q.items[0].source).toBe('terminal');
  });

  it('only genuinely new keys appear in added', () => {
    const s = session('s1');
    const q1 = updateQueue(EMPTY_QUEUE, collectItems([s], { s1: runner('s1', [ask()]) }));
    const q2 = updateQueue(q1, collectItems([s], { s1: runner('s1', [ask(), perm()]) }));
    expect(q2.added).toEqual(['r:s1:req-w']);
  });
});

describe('helpers', () => {
  it('shortModel', () => {
    expect(shortModel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(shortModel('opus')).toBe('Opus');
    expect(shortModel(null)).toBe('');
  });
  it('labelHead / recommended / letters', () => {
    expect(labelHead('เขียนไฟล์: a.txt')).toBe('เขียนไฟล์');
    expect(recommendedIndex([{ label: 'A' }, { label: 'B (Recommended)' }])).toBe(1);
    expect(recommendedIndex([{ label: 'A' }, { label: 'B' }])).toBe(0);
    expect(['ก', 'ข', 'ค'].map((_, i) => optionLetter(i))).toEqual(['ก', 'ข', 'ค']);
  });
  it('count + title text', () => {
    expect(countText(2)).toBe('คำถามรอตอบ 2 ข้อ');
    expect(countText(0)).toBe('ไม่มีคำถามรอตอบ');
    expect(titleWithCount('Claude Control Room', 2)).toBe('(2) Claude Control Room');
    expect(titleWithCount('Claude Control Room', 0)).toBe('Claude Control Room');
  });
  it('notification text = job title + first line of the question', () => {
    const [it] = collectItems([session('s1')], { s1: runner('s1', [ask('Line one\nline two')]) });
    expect(notificationText(it)).toEqual({ title: 'คำถามจาก Job s1', body: 'Line one' });
  });
  it('popup avoids the focused control', () => {
    const corner = { left: 600, top: 60, right: 960, bottom: 380 };
    expect(boxesOverlap(corner, { left: 700, top: 100, right: 800, bottom: 130 })).toBe(true);
    expect(boxesOverlap(corner, { left: 0, top: 100, right: 100, bottom: 130 })).toBe(false);
    expect(choosePlacement(corner, null)).toBe('corner');
    expect(choosePlacement(corner, { left: 700, top: 100, right: 800, bottom: 130 })).toBe('top');
    expect(choosePlacement(corner, { left: 0, top: 500, right: 100, bottom: 530 })).toBe('corner');
    const top = { left: 100, top: 60, right: 1000, bottom: 380 };
    const bottom = { left: 100, top: 600, right: 1000, bottom: 900 };
    const f = { left: 700, top: 100, right: 800, bottom: 130 };
    expect(choosePlacement(corner, f, { ...top, top: 200, bottom: 500 }, bottom)).toBe('top');
    expect(choosePlacement(corner, f, top, bottom)).toBe('bottom');
    expect(choosePlacement(corner, f, top, { ...bottom, top: 60 })).toBe('top');
  });
});
