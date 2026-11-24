import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, derive, ingestLine, summarizeTool, type TranscriptState } from '../src/parser';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures');

const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const at = (sec: number) => T0 + sec * 1000;

function load(name: string): TranscriptState {
  const st = createState();
  for (const line of readFileSync(join(FIX, name), 'utf8').split('\n')) ingestLine(st, line);
  return st;
}

function feed(lines: string[], st: TranscriptState = createState()): TranscriptState {
  for (const l of lines) ingestLine(st, l);
  return st;
}

const prompt = (text: string, sec = 0) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date(at(sec)).toISOString(), origin: { kind: 'human' } });

const assistantTool = (id: string, name: string, input: unknown, sec: number) =>
  JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }, timestamp: new Date(at(sec)).toISOString() });

const assistantText = (text: string, sec: number, stop = 'end_turn') =>
  JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] }, timestamp: new Date(at(sec)).toISOString() });

const toolResult = (id: string, sec: number) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, timestamp: new Date(at(sec)).toISOString() });

describe('title', () => {
  it('uses the last ai-title over the first prompt', () => {
    const d = derive(load('title-ai.jsonl'), { now: at(60), processAlive: true });
    expect(d.title).toBe('Final sample title');
  });

  it('falls back to the first human prompt, skipping <wrapper> and tool_result-only entries', () => {
    const d = derive(load('title-prompt.jsonl'), { now: at(60), processAlive: true });
    expect(d.title).toBe('Example real prompt: rename the sample module');
  });

  it('gives (ไม่มีชื่อ) for an empty transcript', () => {
    const d = derive(createState(), { now: at(0), processAlive: true });
    expect(d.title).toBe('(ไม่มีชื่อ)');
  });

  it('caps the title at 80 characters', () => {
    const long = 'x'.repeat(200);
    const st = feed([prompt(long)]);
    const d = derive(st, { now: at(1), processAlive: true });
    expect(d.title.length).toBeLessThanOrEqual(80);
    expect(d.title.startsWith('xxxx')).toBe(true);
  });

  it('ignores prompts that come from a peer origin', () => {
    const peer = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Peer message text' }, timestamp: new Date(at(0)).toISOString(), origin: { kind: 'peer' } });
    const d = derive(feed([peer]), { now: at(1), processAlive: true });
    expect(d.title).toBe('(ไม่มีชื่อ)');
  });
});

describe('model and effort', () => {
  it('picks the last real model (ignoring <synthetic>) and the latest effort', () => {
    const d = derive(load('models.jsonl'), { now: at(60), processAlive: true });
    expect(d.model).toBe('claude-opus-5-5');
    expect(d.effort).toBe('high');
  });

  it('is null when no assistant entry has them', () => {
    const d = derive(feed([prompt('only a prompt')]), { now: at(1), processAlive: true });
    expect(d.model).toBeNull();
    expect(d.effort).toBeNull();
  });
});

describe('status', () => {
  it('running: pending Bash started 40s ago', () => {
    const d = derive(load('running.jsonl'), { now: at(60), processAlive: true });
    expect(d.status).toBe('running');
  });

  it('running: no pending tool but transcript written 5s ago', () => {
    const st = feed([prompt('hello', 0), assistantText('Hi.', 95)]);
    const d = derive(st, { now: at(100), processAlive: true });
    expect(d.status).toBe('running');
  });

  it('idle: end_turn long ago and nothing pending', () => {
    const d = derive(load('idle.jsonl'), { now: at(3600), processAlive: true });
    expect(d.status).toBe('idle');
  });

  it('idle: pending Bash older than 10 min with no recent activity is not running', () => {
    const d = derive(load('running.jsonl'), { now: at(20 + 11 * 60), processAlive: true });
    expect(d.status).toBe('idle');
  });

  it('waiting: pending AskUserQuestion', () => {
    const d = derive(load('waiting.jsonl'), { now: at(40), processAlive: true });
    expect(d.status).toBe('waiting');
  });

  it('waiting: pending ExitPlanMode also counts', () => {
    const st = feed([assistantTool('p1', 'ExitPlanMode', { plan: 'x' }, 0)]);
    expect(derive(st, { now: at(1), processAlive: true }).status).toBe('waiting');
  });

  it('no longer waiting once the tool_result arrives', () => {
    const st = load('waiting.jsonl');
    expect(derive(st, { now: at(40), processAlive: true }).status).toBe('waiting');
    const answered = readFileSync(join(FIX, 'answered.jsonl'), 'utf8').split('\n');
    feed(answered, st);
    expect(derive(st, { now: at(600), processAlive: true }).status).toBe('idle');
  });

  it('done when processAlive is false, even with a pending tool', () => {
    const d = derive(load('running.jsonl'), { now: at(60), processAlive: false });
    expect(d.status).toBe('done');
  });

  it('done when a subagent is marked finished (processAlive null)', () => {
    const d = derive(load('idle.jsonl'), { now: at(60), processAlive: null, finished: true });
    expect(d.status).toBe('done');
  });

  it('processAlive null (subagent) is not treated as dead', () => {
    const d = derive(load('running.jsonl'), { now: at(60), processAlive: null });
    expect(d.status).toBe('running');
  });

  it('unreadable: a file of garbage gives a reason and does not guess', () => {
    const d = derive(load('garbage.jsonl'), { now: at(60), processAlive: true });
    expect(d.status).toBe('unreadable');
    expect(d.unreadable).toMatch(/no recognised/);
  });

  it('unreadable: unknown-type lines only (valid JSON, nothing recognised)', () => {
    const st = feed(['{"type":"mystery"}', '{"type":"other","x":1}']);
    expect(derive(st, { now: at(1), processAlive: true }).status).toBe('unreadable');
  });

  it('unreadable: more than half bad with at least 10 lines', () => {
    const lines = [prompt('ok', 0)];
    for (let i = 0; i < 10; i++) lines.push('not json ' + i);
    const d = derive(feed(lines), { now: at(1), processAlive: true });
    expect(d.status).toBe('unreadable');
    expect(d.unreadable).toMatch(/not valid JSON/);
  });

  it('not unreadable: a few bad lines among many good ones', () => {
    const st = load('messy.jsonl');
    const d = derive(st, { now: at(3600), processAlive: true });
    expect(d.status).toBe('idle');
    expect(d.unreadable).toBeUndefined();
  });
});

describe('thought', () => {
  it('priority 1: non-empty thinking of the latest assistant entry', () => {
    const d = derive(load('thought-thinking.jsonl'), { now: at(30), processAlive: true });
    expect(d.thought).toBe('Plan: check the sample config first.');
  });

  it('priority 2: summary of the oldest pending tool_use when thinking is empty', () => {
    const d = derive(load('running.jsonl'), { now: at(60), processAlive: true });
    expect(d.thought).toBe('คำสั่ง: Run sample tests');
  });

  it('priority 3: first non-empty line of the last assistant text', () => {
    const d = derive(load('idle.jsonl'), { now: at(3600), processAlive: true });
    expect(d.thought).toBe('First line of the answer.');
  });

  it('empty string when there is nothing to show', () => {
    const d = derive(feed([prompt('just a prompt')]), { now: at(1), processAlive: true });
    expect(d.thought).toBe('');
  });

  it('is single-line and at most 120 characters', () => {
    const st = feed([assistantText('line one\n' + 'word '.repeat(100), 0)]);
    const d = derive(st, { now: at(1), processAlive: true });
    expect(d.thought).not.toMatch(/\n/);
    expect(d.thought.length).toBeLessThanOrEqual(120);
  });
});

describe('timeline', () => {
  it('oldest first, with user / text / tool / error kinds', () => {
    const d = derive(load('timeline.jsonl'), { now: at(60), processAlive: true });
    expect(d.timeline.map((e) => e.kind)).toEqual(['user', 'text', 'tool', 'error', 'tool', 'text']);
    expect(d.timeline.map((e) => e.text)).toEqual([
      'Example prompt for the timeline',
      'Working on it.\nMore detail follows.',
      'คำสั่ง: Build sample',
      'Build failed',
      'อ่านไฟล์: notes.txt',
      'Done.',
    ]);
    const ts = d.timeline.map((e) => e.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts[0]).toBe(at(0));
  });

  it('error kind takes the first line of a string tool_result content', () => {
    const st = feed([assistantTool('e1', 'Bash', { command: 'x' }, 0), JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: true, content: '\n  Command exploded\nmore' }] }, timestamp: new Date(at(1)).toISOString() })]);
    const d = derive(st, { now: at(2), processAlive: true });
    const err = d.timeline.find((e) => e.kind === 'error');
    expect(err?.text).toBe('Command exploded');
  });

  it('keeps only the last 30 events', () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(prompt(`prompt ${i}`, i));
    const d = derive(feed(lines), { now: at(100), processAlive: true });
    expect(d.timeline).toHaveLength(30);
    expect(d.timeline[0].text).toBe('prompt 10');
    expect(d.timeline[29].text).toBe('prompt 39');
  });

  it('keeps the whole prompt and the whole answer with newlines, capped at 4000', () => {
    const answer = ['งานค้าง เรียงตามความด่วน:', '1. gallery', '2. bug กล่องซ้ำ'].join('\n');
    const d = derive(feed([prompt('y'.repeat(5000)), assistantText(answer, 1)]), { now: at(2), processAlive: true });
    expect(d.timeline[0].text.length).toBe(4000);
    expect(d.timeline[1]).toMatchObject({ kind: 'text', text: answer });
  });

  it('tool lines stay one short line', () => {
    const d = derive(feed([assistantTool('t1', 'Bash', { command: 'x'.repeat(400), description: 'd'.repeat(400) }, 1)]), { now: at(2), processAlive: true });
    expect(d.timeline[0].kind).toBe('tool');
    expect(d.timeline[0].text.length).toBeLessThanOrEqual(160);
    expect(d.timeline[0].text).not.toContain('\n');
  });
});

describe('robustness', () => {
  it('tolerates blank lines, unknown types, noise types and a partial last line', () => {
    const st = load('messy.jsonl');
    const d = derive(st, { now: at(3600), processAlive: true });
    expect(d.title).toBe('Messy file prompt');
    expect(d.timeline.map((e) => e.kind)).toEqual(['user', 'text']);
    expect(d.thought).toBe('Messy reply.');
    expect(st.totalLines).toBe(5); // non-blank lines only
    expect(st.badLines).toBe(1); // only the truncated line
  });

  it('never throws on arbitrary garbage input', () => {
    const st = createState();
    expect(() => {
      ingestLine(st, '');
      ingestLine(st, '   ');
      ingestLine(st, 'null');
      ingestLine(st, '[1,2]');
      ingestLine(st, '"str"');
      ingestLine(st, '{"type":42}');
      ingestLine(st, '{"type":"assistant","message":null}');
      ingestLine(st, '{"type":"user","message":{"content":[null,5,{"type":"tool_result"}]}}');
      ingestLine(st, '{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}');
      ingestLine(st, undefined as unknown as string);
    }).not.toThrow();
    expect(() => derive(st, { now: at(0), processAlive: true })).not.toThrow();
  });

  it('lastActivity is the max timestamp over recognised entries', () => {
    const st = feed([
      prompt('a', 50),
      JSON.stringify({ type: 'mystery', timestamp: new Date(at(900)).toISOString() }),
      assistantText('b', 20),
    ]);
    expect(derive(st, { now: at(60), processAlive: true }).lastActivity).toBe(at(50));
  });

  it('a tool_result clears the matching pending tool_use', () => {
    const st = feed([assistantTool('z1', 'Bash', { command: 'ls', description: 'List' }, 0), toolResult('z1', 1)]);
    expect(st.pending.size).toBe(0);
  });
});

describe('summarizeTool', () => {
  it('uses Thai labels and keeps the detail', () => {
    expect(summarizeTool('Bash', { command: 'a\nb', description: 'Do thing' })).toBe('คำสั่ง: Do thing');
    expect(summarizeTool('Edit', { file_path: 'C:\\proj\\a.ts' })).toBe('แก้ไฟล์: a.ts');
  });

  it('never throws on odd input and stays within 100 characters', () => {
    expect(summarizeTool('Bash', null)).toBe('คำสั่ง');
    expect(summarizeTool('Edit', ['x'])).toBe('แก้ไฟล์');
    expect(summarizeTool(undefined as unknown as string, undefined)).toBe('tool');
    expect(summarizeTool('Bash', { description: 'z'.repeat(500) }).length).toBeLessThanOrEqual(100);
  });
});

describe('waitItems (stage 3 payload mapping)', () => {
  const askInput = {
    questions: [
      { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: '' }] },
    ],
  };

  it('maps a pending AskUserQuestion to an ask item with its options', () => {
    const st = feed([prompt('go'), assistantTool('q1', 'AskUserQuestion', askInput, 5)]);
    const d = derive(st, { now: at(6), processAlive: true });
    expect(d.status).toBe('waiting');
    expect(d.waitItems).toHaveLength(1);
    const it = d.waitItems[0];
    expect(it).toMatchObject({ id: 'q1', kind: 'ask', toolName: 'AskUserQuestion', detail: 'Which colour?', at: at(5) });
    expect(it.questions?.[0].options.map((o) => o.label)).toEqual(['Red', 'Blue']);
  });

  it('drops the item once its tool_result arrives', () => {
    const st = feed([prompt('go'), assistantTool('q1', 'AskUserQuestion', askInput, 5), toolResult('q1', 8)]);
    expect(derive(st, { now: at(9), processAlive: true }).waitItems).toEqual([]);
  });

  it('reports a permission prompt only when Claude says waiting, using the OLDEST other pending tool', () => {
    const st = feed([
      prompt('go'),
      assistantTool('w1', 'Write', { file_path: 'C:/x/ok.txt', content: 'hi' }, 5),
      assistantTool('b1', 'Bash', { command: 'ls' }, 6),
    ]);
    expect(derive(st, { now: at(7), processAlive: true }).waitItems).toEqual([]);
    const d = derive(st, { now: at(7), processAlive: true, liveWaiting: true });
    expect(d.waitItems).toHaveLength(1);
    expect(d.waitItems[0]).toMatchObject({ id: 'w1', kind: 'permission', toolName: 'Write', detail: 'ok.txt' });
    expect(d.waitItems[0].label).toBe('ขออนุญาตเขียนไฟล์: ok.txt');
  });

  it('maps ExitPlanMode to a plan-approval item and orders items oldest first', () => {
    const st = feed([
      prompt('go'),
      assistantTool('p1', 'ExitPlanMode', { plan: 'Step one\nStep two' }, 9),
      assistantTool('q1', 'AskUserQuestion', askInput, 5),
    ]);
    const d = derive(st, { now: at(10), processAlive: true });
    expect(d.waitItems.map((i) => i.id)).toEqual(['q1', 'p1']);
    expect(d.waitItems[1]).toMatchObject({ kind: 'permission', label: 'ขออนุมัติแผน', detail: 'Step one' });
  });

  it('has no items for a finished session', () => {
    const st = feed([prompt('go'), assistantTool('q1', 'AskUserQuestion', askInput, 5)]);
    expect(derive(st, { now: at(6), processAlive: false }).waitItems).toEqual([]);
  });
});
