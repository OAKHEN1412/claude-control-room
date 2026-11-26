import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/accounts.ts';
import { TERMINAL_ACCOUNT_ID } from '../../shared/accounts.ts';
import type { RunnerState, SessionInfo, TimelineEvent } from '../../shared/protocol.ts';
import { TimelinePrinter, eventLines, formatList, listRows, makePaint, newEvents, eventKey, profileLabel, toolCall } from '../src/format.ts';

const plain = makePaint(false);
const ev = (ts: number, kind: TimelineEvent['kind'], text: string): TimelineEvent => ({ ts, kind, text });

describe('eventLines', () => {
  it('user dim with >, assistant text keeps every line under the mark, tool is Name(args), error nests under a tool', () => {
    expect(eventLines(ev(1, 'user', 'a\nb'), false, plain)).toEqual(['> a', '  b']);
    expect(eventLines(ev(1, 'text', 'one\ntwo\n\n'), false, plain)).toEqual(['⏺ one', '  two']);
    expect(eventLines(ev(1, 'tool', 'Read: src/App.tsx'), false, plain)).toEqual(['⏺ Read(src/App.tsx)']);
    expect(eventLines(ev(1, 'tool', 'Bash'), false, plain)).toEqual(['⏺ Bash']);
    expect(eventLines(ev(1, 'error', 'boom'), true, plain)).toEqual(['  ⎿ boom']);
    expect(eventLines(ev(1, 'error', 'boom'), false, plain)).toEqual(['⏺ boom']);
  });

  it('long tool arguments and errors are shortened to one line', () => {
    const long = 'x'.repeat(200);
    expect(toolCall(`Bash: ${long}`).length).toBeLessThan(90);
    expect(toolCall(`Bash: ${long}`).endsWith('…)')).toBe(true);
    const [line] = eventLines(ev(1, 'error', `${long}\nsecond`), true, plain);
    expect(line.length).toBeLessThan(120);
    expect(line).not.toContain('\n');
  });

  it('colours only when asked', () => {
    expect(eventLines(ev(1, 'error', 'e'), false, makePaint(true))[0]).toContain('\x1b[31m');
    expect(eventLines(ev(1, 'error', 'e'), false, plain)[0]).not.toContain('\x1b');
  });
});

describe('newEvents / TimelinePrinter', () => {
  const a = ev(1, 'user', 'hi');
  const b = ev(2, 'tool', 'Read: a');
  const c = ev(3, 'text', 'done');

  it('returns only what follows the last printed event, also when the window slid', () => {
    expect(newEvents([a, b, c], null, 0)).toEqual([a, b, c]);
    expect(newEvents([a, b, c], eventKey(b), 2)).toEqual([c]);
    expect(newEvents([b, c], eventKey(a), 1)).toEqual([b, c]); // a left the window
    expect(newEvents([a, b, c], eventKey(c), 3)).toEqual([]);
  });

  it('prints each event once across updates', () => {
    const p = new TimelinePrinter(plain);
    expect(p.update([a])).toEqual(['> hi']);
    expect(p.update([a])).toEqual([]);
    expect(p.update([a, b, c])).toEqual(['⏺ Read(a)', '⏺ done']);
    expect(p.update([a, b, c])).toEqual([]);
  });

  it('the first update is limited to the newest `history` events', () => {
    const many = Array.from({ length: 30 }, (_, i) => ev(i + 1, 'text', `m${i}`));
    const lines = new TimelinePrinter(plain, 5).update(many);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('ข้ามประวัติเก่า 25');
    expect(lines[5]).toBe('⏺ m29');
  });

  it('a line typed in this terminal is not echoed again from the timeline (but the same text from the web is)', () => {
    const p = new TimelinePrinter(plain);
    p.update([]);
    p.noteSent('สวัสดี');
    expect(p.update([ev(10, 'user', 'สวัสดี')])).toEqual([]);
    expect(p.update([ev(10, 'user', 'สวัสดี'), ev(20, 'user', 'สวัสดี')])).toEqual(['> สวัสดี']);
  });

  it('an error after a tool nests, after text it does not', () => {
    const p = new TimelinePrinter(plain);
    expect(p.update([ev(1, 'tool', 'Bash: ls'), ev(2, 'error', 'fail'), ev(3, 'text', 'ok'), ev(4, 'error', 'api')])).toEqual([
      '⏺ Bash(ls)',
      '  ⎿ fail',
      '⏺ ok',
      '⏺ api',
    ]);
  });
});

describe('cr ls rows', () => {
  const sess = (id: string, status: SessionInfo['status'], title = 't'): SessionInfo => ({
    sessionId: id,
    pid: 1,
    name: 'n',
    cwd: 'C:\\w',
    kind: 'interactive',
    title,
    model: null,
    effort: null,
    status,
    thought: '',
    startedAt: 0,
    lastActivity: 0,
    timeline: [],
    subagents: [],
  });
  const run = (id: string, over: Partial<RunnerState> = {}): RunnerState => ({
    sessionId: id,
    cwd: 'C:\\w',
    alive: true,
    pid: 5,
    busy: false,
    queued: 0,
    model: 'haiku',
    effort: 'high',
    confirmed: true,
    permissionMode: 'default',
    remoteControl: false,
    pending: [],
    startedAt: 0,
    ...over,
  });

  it('web jobs first with their state, terminal sessions after; finished ones only with --all', () => {
    const rows = listRows([sess('a1', 'idle', 'ของเว็บ'), sess('t1', 'running'), sess('t2', 'done')], [run('a1', { busy: true, queued: 2 })], false);
    expect(rows.map((r) => [r.id, r.kind, r.state])).toEqual([
      ['a1', 'web', 'ทำงาน (+2)'],
      ['t1', 'terminal', 'ทำงาน'],
    ]);
    expect(rows[0].title).toBe('ของเว็บ');
    expect(listRows([sess('t2', 'done')], [], true)).toHaveLength(1);
    expect(listRows([], [run('a2', { pending: [{} as never] })], false)[0].state).toBe('รอคุณ 1');
    expect(listRows([], [run('a3', { alive: false })], false)[0].state).toBe('หยุดแล้ว');
  });

  it('formats one line per row with the 8-character id; empty list says so', () => {
    const lines = formatList(listRows([sess('abcdef1234567890', 'idle', 'Hello')], [], false), plain);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('abcdef12');
    expect(lines[0]).toContain('Hello');
    expect(lines[0]).toContain('C:\\w');
    expect(formatList([], plain)[0]).toContain('ไม่มีงาน');
  });
});

describe('cr ls profile column', () => {
  const sess = (id: string): SessionInfo => ({
    sessionId: id,
    pid: 1,
    name: 'n',
    cwd: 'C:\\w',
    kind: 'interactive',
    title: 'T',
    model: null,
    effort: null,
    status: 'idle',
    thought: '',
    startedAt: 0,
    lastActivity: 0,
    timeline: [],
    subagents: [],
  });
  const run = (id: string, over: Partial<RunnerState> = {}): RunnerState => ({
    sessionId: id,
    cwd: 'C:\\w',
    alive: true,
    pid: 5,
    busy: false,
    queued: 0,
    model: 'haiku',
    effort: 'high',
    confirmed: true,
    permissionMode: 'default',
    remoteControl: false,
    pending: [],
    startedAt: 0,
    ...over,
  });
  const acct = (id: string, name: string): AccountInfo => ({
    id,
    name,
    color: '#ef4444',
    letter: 'W',
    note: '',
    builtin: id === TERMINAL_ACCOUNT_ID,
    tokenState: 'set',
    fingerprint: null,
    createdAt: 1,
    tokenAt: null,
    expiresAt: null,
    lastCheckAt: null,
    lastCheckOk: null,
    usage: null,
    hidden: false,
    locked: false, hasPassword: false,
  });
  const accounts = [acct('terminal', 'Terminal login'), acct('work-1', 'Work Account')];

  it('a web row shows its profile name; terminal login prints "terminal"; an unknown id prints the id', () => {
    const rows = listRows(
      [sess('a1'), sess('a2'), sess('a3')],
      [run('a1', { accountId: 'work-1' }), run('a2', { accountId: 'terminal' }), run('a3', { accountId: 'gone' })],
      false,
      accounts,
    );
    expect(rows.map((r) => r.account)).toEqual(['Work Account', 'terminal', 'gone']);
    const lines = formatList(rows, plain);
    expect(lines[0]).toContain('Work Account');
    expect(lines[1]).toMatch(/terminal\s+C:\\w$/);
    expect(lines[2]).toMatch(/gone\s+C:\\w$/);
  });

  it('rows without an accountId get no account and no column', () => {
    const rows = listRows([sess('a1')], [run('a1')], false, accounts);
    expect(rows[0].account).toBeUndefined();
    expect(formatList(rows, plain)).toEqual(formatList(listRows([sess('a1')], [run('a1')], false), plain));
  });

  it('the profile column is aligned across rows when some rows have one', () => {
    const rows = listRows([sess('a1'), sess('a2')], [run('a1', { accountId: 'work-1' }), run('a2')], false, accounts);
    const [withAcct, without] = formatList(rows, plain);
    expect(withAcct.indexOf('Work Account')).toBe(without.indexOf('C:\\w') - 'Work Account'.length - 2);
  });

  it('profileLabel: terminal prints "terminal" even when the list names it differently', () => {
    expect(profileLabel('terminal', accounts)).toBe('terminal');
    expect(profileLabel('work-1', [])).toBe('work-1');
  });
});
