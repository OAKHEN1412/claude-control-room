import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../../shared/protocol';
import { MAX_ARGS, MAX_RESULT, formatTimeline, hhmm, keepLines, mergeAccountSwitches, splitTool, switchName, thoughtLine, toolCall, type AccountSwitch } from './terminalLines';

const ev = (kind: TimelineEvent['kind'], text: string, ts = 1): TimelineEvent => ({ ts, kind, text });

describe('splitTool / toolCall', () => {
  it('turns "Name: args" into Name(args)', () => {
    expect(splitTool('Read: src/App.tsx')).toEqual({ name: 'Read', args: 'src/App.tsx' });
    expect(toolCall('Read: src/App.tsx').text).toBe('Read(src/App.tsx)');
  });

  it('keeps colons inside the args and works with Thai labels', () => {
    expect(toolCall('อ่านไฟล์: C:/a/b.ts').text).toBe('อ่านไฟล์(C:/a/b.ts)');
    expect(toolCall('Bash: git log --format=a: b').text).toBe('Bash(git log --format=a: b)');
  });

  it('shows a call without args as a bare name', () => {
    expect(toolCall('TodoWrite')).toEqual({ text: 'TodoWrite', full: 'TodoWrite' });
    expect(toolCall('Glob:').text).toBe('Glob:');
  });

  it('shortens long args but keeps the full call', () => {
    const args = 'x'.repeat(200);
    const c = toolCall(`Bash: ${args}`);
    expect(c.text.length).toBeLessThanOrEqual('Bash()'.length + MAX_ARGS);
    expect(c.text.endsWith('…)')).toBe(true);
    expect(c.full).toBe(`Bash(${args})`);
  });
});

describe('formatTimeline', () => {
  it('maps user, assistant and tool events to prompt, bullet and call lines', () => {
    const lines = formatTimeline([ev('user', 'ทำต่อ'), ev('text', 'ได้เลย'), ev('tool', 'Read: a.ts')]);
    expect(lines.map((l) => [l.kind, l.mark, l.text, l.nested])).toEqual([
      ['user', '>', 'ทำต่อ', false],
      ['assistant', '⏺', 'ได้เลย', false],
      ['tool', '⏺', 'Read(a.ts)', false],
    ]);
  });

  it('shows an error after a tool call as its nested ⎿ result line', () => {
    const lines = formatTimeline([ev('tool', 'Bash: npm test'), ev('error', 'exit code 1')]);
    expect(lines[1]).toMatchObject({ kind: 'error', mark: '⎿', nested: true, text: 'exit code 1' });
  });

  it('nests a second error under the same call', () => {
    const lines = formatTimeline([ev('tool', 'Bash: x'), ev('error', 'one'), ev('error', 'two')]);
    expect(lines.map((l) => l.nested)).toEqual([false, true, true]);
  });

  it('shows an error with no preceding call as a plain ⏺ line', () => {
    const afterText = formatTimeline([ev('text', 'hi'), ev('error', 'API error')]);
    expect(afterText[1]).toMatchObject({ kind: 'error', mark: '⏺', nested: false });
    expect(formatTimeline([ev('error', 'first')])[0].nested).toBe(false);
  });

  it('a user or assistant line ends the tool group', () => {
    const lines = formatTimeline([ev('tool', 'Read: a'), ev('text', 'ok'), ev('error', 'late')]);
    expect(lines[2].nested).toBe(false);
  });

  it('collapses a long error and keeps the full text for expanding', () => {
    const long = 'e'.repeat(300);
    const l = formatTimeline([ev('tool', 'Bash: x'), ev('error', long)])[1];
    expect(l.collapsible).toBe(true);
    expect(l.text.length).toBeLessThanOrEqual(MAX_RESULT);
    expect(l.full).toBe(long);
  });

  it('does not mark short lines collapsible and keeps keys unique', () => {
    const lines = formatTimeline([ev('tool', 'Read: a', 5), ev('tool', 'Read: a', 5), ev('error', 'x', 5)]);
    expect(lines.every((l) => !l.collapsible)).toBe(true);
    expect(new Set(lines.map((l) => l.key)).size).toBe(3);
  });

  it('keeps the timestamp and returns nothing for no events', () => {
    expect(formatTimeline([ev('user', 'a', 42)])[0].ts).toBe(42);
    expect(formatTimeline([])).toEqual([]);
  });
});

describe('multi-line text', () => {
  const answer = 'สรุปผล:\n- ข้อหนึ่ง\n- ข้อสอง\n\nจบ';

  it('keeps every line of an assistant answer, with the mark only on the block', () => {
    const [l] = formatTimeline([ev('text', answer)]);
    expect(l.text).toBe(answer);
    expect(l.full).toBe(answer);
    expect(l.rows).toBe(5);
    expect(l.mark).toBe('⏺');
    expect(l.collapsible).toBe(false);
  });

  it('keeps every line of a user prompt after the > mark', () => {
    const [l] = formatTimeline([ev('user', 'ทำสามอย่าง\n1. a\n2. b')]);
    expect(l).toMatchObject({ kind: 'user', mark: '>', rows: 3, text: 'ทำสามอย่าง\n1. a\n2. b' });
  });

  it('does not clip a long answer (the server keeps up to 4000 characters)', () => {
    const long = `${'บรรทัดยาว '.repeat(380)}\nจบ`;
    expect(formatTimeline([ev('text', long)])[0].text.length).toBe(keepLines(long).length);
  });

  it('normalises CRLF and drops trailing blank space', () => {
    expect(keepLines('a\r\nb\r\n\r\n  ')).toBe('a\nb');
    expect(formatTimeline([ev('text', 'a\r\nb\n\n')])[0]).toMatchObject({ text: 'a\nb', rows: 2 });
  });

  it('still shows tool calls and errors on one line', () => {
    const lines = formatTimeline([ev('tool', 'Bash: echo a\necho b'), ev('error', 'line one\nline two')]);
    expect(lines[0].text).toBe('Bash(echo a echo b)');
    expect(lines[1].text).toBe('line one line two');
    expect(lines.map((l) => l.rows)).toEqual([1, 1]);
  });
});

describe('thoughtLine', () => {
  it('makes a ✻ line, or nothing when empty', () => {
    expect(thoughtLine('  กำลังคิด ')).toMatchObject({ kind: 'thought', mark: '✻', text: 'กำลังคิด' });
    expect(thoughtLine('   ')).toBeNull();
  });
});

describe('mergeAccountSwitches', () => {
  const label = (sw: AccountSwitch, time: string) => `— สลับบัญชี ${sw.from} → ${sw.to} ${time} —`;
  const at = (h: number, m: number) => new Date(2026, 10, 26, h, m, 0).getTime();
  const lines = () => formatTimeline([ev('user', 'a', at(9, 0)), ev('text', 'b', at(9, 30)), ev('tool', 'Read: x', at(10, 0))]);

  it('returns the same lines when there is no log or an empty one', () => {
    const base = lines();
    expect(mergeAccountSwitches(base, undefined, label)).toBe(base);
    expect(mergeAccountSwitches(base, [], label)).toBe(base);
  });

  it('places each divider in time order among the lines, whatever the log order', () => {
    const log = [
      { at: at(10, 15), from: 'งาน', to: 'ทดสอบ' },
      { at: at(9, 15), from: 'ล็อกอินเทอร์มินัล', to: 'งาน' },
    ];
    const out = mergeAccountSwitches(lines(), log, label);
    expect(out.map((l) => l.kind)).toEqual(['user', 'switch', 'assistant', 'tool', 'switch']);
    expect(out[1].text).toBe('— สลับบัญชี ล็อกอินเทอร์มินัล → งาน 09:15 —');
    expect(out[4].text).toBe('— สลับบัญชี งาน → ทดสอบ 10:15 —');
  });

  it('shows a repeated switch once', () => {
    const sw = { at: at(9, 15), from: 'a', to: 'b' };
    const out = mergeAccountSwitches(lines(), [sw, { ...sw }], label);
    expect(out.filter((l) => l.kind === 'switch')).toHaveLength(1);
  });

  it('keeps the switch after a line stamped at the same time, and at the end when later', () => {
    const same = mergeAccountSwitches(formatTimeline([ev('user', 'a', at(9, 0))]), [{ at: at(9, 0), from: 'a', to: 'b' }], label);
    expect(same.map((l) => l.kind)).toEqual(['user', 'switch']);
    const late = mergeAccountSwitches(lines(), [{ at: at(12, 0), from: 'a', to: 'b' }], label);
    expect(late[late.length - 1].kind).toBe('switch');
  });

  it('formats HH:MM in 24 h', () => {
    expect(hhmm(at(13, 7))).toBe('13:07');
    expect(hhmm(at(0, 5))).toBe('00:05');
  });
});

describe('switchName (built-in profile in the switch divider)', () => {
  it('replaces the stored English built-in names with the translated Main account label', () => {
    expect(switchName('Main account', 'บัญชีหลัก')).toBe('บัญชีหลัก');
    expect(switchName('Terminal login', 'บัญชีหลัก')).toBe('บัญชีหลัก');
  });

  it('leaves other profile names unchanged', () => {
    expect(switchName('Work', 'บัญชีหลัก')).toBe('Work');
  });

  it('builds the divider text with the translated name', () => {
    const log: AccountSwitch[] = [{ at: 1_800_000_000_000, from: 'Main account', to: 'OAK' }];
    const lines = mergeAccountSwitches([], log, (sw, time) => `— ${switchName(sw.from, 'บัญชีหลัก')} → ${switchName(sw.to, 'บัญชีหลัก')} ${time} —`);
    expect(lines[0]!.text).toMatch(/^— บัญชีหลัก → OAK \d{2}:\d{2} —$/);
  });
});
