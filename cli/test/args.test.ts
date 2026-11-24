import { describe, expect, it } from 'vitest';
import { parseArgs, resolvePrefix } from '../src/args.ts';

const parse = (argv: string[], env: Record<string, string> = {}) => parseArgs(argv, 'C:\\work', env);

describe('parseArgs', () => {
  it('no arguments = ls; port from CR_PORT, --port wins, default 8790', () => {
    expect(parse([])).toMatchObject({ ok: true, port: 8790, command: { kind: 'ls', all: false } });
    expect(parse(['ls', '--all'])).toMatchObject({ command: { kind: 'ls', all: true } });
    expect(parse([], { CR_PORT: '8797' })).toMatchObject({ port: 8797 });
    expect(parse(['--port', '9001'], { CR_PORT: '8797' })).toMatchObject({ port: 9001 });
    expect(parse(['--port=9002'])).toMatchObject({ port: 9002 });
    expect(parse([], { CR_PORT: 'abc' })).toMatchObject({ port: 8790 });
    expect(parse(['--port', '99999'])).toMatchObject({ ok: false });
  });

  it('new: cwd defaults to the current folder, prompt words are joined, model/effort validated', () => {
    expect(parse(['new', 'ตอบคำว่า', 'OK'])).toMatchObject({
      ok: true,
      command: { kind: 'new', cwd: 'C:\\work', model: 'opus', effort: 'high', prompt: 'ตอบคำว่า OK', attach: true },
    });
    expect(parse(['new', '--cwd', 'D:\\x', '--model', 'haiku', '--effort', 'low', '--no-attach', 'hi'])).toMatchObject({
      command: { cwd: 'D:\\x', model: 'haiku', effort: 'low', prompt: 'hi', attach: false },
    });
    expect(parse(['new', '--model=sonnet', 'a'])).toMatchObject({ command: { model: 'sonnet' } });
    expect(parse(['new', '--model', 'qwen', 'a'])).toMatchObject({ ok: false }); // disabled in the Runner
    expect(parse(['new', '--model', 'nope', 'a'])).toMatchObject({ ok: false });
    expect(parse(['new', '--effort', 'turbo', 'a'])).toMatchObject({ ok: false });
    expect(parse(['new'])).toMatchObject({ ok: true, command: { prompt: '' } });
    expect(parse(['new', '--', '--weird', 'text'])).toMatchObject({ command: { prompt: '--weird text' } });
  });

  it('takeover needs one id; -y skips the question; --machine passes through', () => {
    expect(parse(['takeover', 'ab12'])).toMatchObject({ ok: true, command: { kind: 'takeover', id: 'ab12', yes: false } });
    expect(parse(['takeover', 'ab12', '-y'])).toMatchObject({ command: { kind: 'takeover', yes: true } });
    expect(parse(['takeover', '--yes', 'ab12', '--machine', 'm1'])).toMatchObject({ machine: 'm1', command: { yes: true } });
    expect(parse(['takeover'])).toMatchObject({ ok: false });
    expect(parse(['takeover', 'a', 'b'])).toMatchObject({ ok: false });
  });

  it('attach / resume need exactly one id; unknown things are refused with Thai text', () => {
    expect(parse(['attach', 'ab12'])).toMatchObject({ command: { kind: 'attach', id: 'ab12' } });
    expect(parse(['attach'])).toMatchObject({ ok: false });
    expect(parse(['attach', 'a', 'b'])).toMatchObject({ ok: false });
    expect(parse(['resume', 'ab12', '--model', 'haiku'])).toMatchObject({ command: { kind: 'resume', id: 'ab12', model: 'haiku' } });
    const bad = parse(['frobnicate']);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain('ไม่รู้จักคำสั่ง');
    expect(parse(['ls', '--nope'])).toMatchObject({ ok: false });
    expect(parse(['--cwd'])).toMatchObject({ ok: false });
    expect(parse(['-h'])).toMatchObject({ command: { kind: 'help' } });
  });

  it('--machine / CR_MACHINE is a passthrough, validated', () => {
    expect(parse(['ls', '--machine', 'm1'])).toMatchObject({ machine: 'm1' });
    expect(parse(['ls'], { CR_MACHINE: 'box-2' })).toMatchObject({ machine: 'box-2' });
    expect(parse(['ls', '--machine', 'a b'])).toMatchObject({ ok: false });
    expect(parse(['ls'])).not.toHaveProperty('machine');
  });
});

describe('resolvePrefix', () => {
  const ids = ['aaaa1111-0000-4000-8000-000000000001', 'aaaa2222-0000-4000-8000-000000000002', 'bbbb3333-0000-4000-8000-000000000003'];
  it('finds a unique prefix (case-insensitive) and explains the other cases', () => {
    expect(resolvePrefix('bbbb', ids)).toEqual({ ok: true, id: ids[2] });
    expect(resolvePrefix('AAAA2', ids)).toEqual({ ok: true, id: ids[1] });
    expect(resolvePrefix('aaaa', ids)).toMatchObject({ ok: false, error: expect.stringContaining('หลายงาน') });
    expect(resolvePrefix('cccc', ids)).toMatchObject({ ok: false, error: expect.stringContaining('ไม่พบ') });
    expect(resolvePrefix('aa', ids)).toMatchObject({ ok: false, error: expect.stringContaining('สั้นเกินไป') });
    expect(resolvePrefix('zz!!', ids)).toMatchObject({ ok: false });
    expect(resolvePrefix(ids[0], [ids[0], ids[0]])).toEqual({ ok: true, id: ids[0] }); // the same id listed twice is one hit
  });
});
