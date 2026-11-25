import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerState, ServerMsg } from '../../shared/protocol';
import { ClipService } from '../src/clips';
import { fileLogger } from '../src/cmdlog';
import { parseClientMsg } from '../src/commands';
import { knownCwds } from '../src/cwds';
import { startServer, type RunningServer } from '../src/index';
import { WorklogDb } from '../src/db';
import { CommandError, Runner, RunnerSession, childEnv, normPath, type ChildLike } from '../src/runner';
import { Watcher } from '../src/watcher';

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killedWith: unknown[] = [];
  written: Record<string, any>[] = [];
  initializes: Record<string, any>[] = []; // the slash-menu initialize request, kept apart from the rest
  private buf = '';
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const w = JSON.parse(this.buf.slice(0, i));
        if (w.type === 'control_request' && w.request?.subtype === 'initialize') this.initializes.push(w);
        else this.written.push(w);
        this.buf = this.buf.slice(i + 1);
      }
    });
  }
  kill(sig?: NodeJS.Signals | number): boolean {
    this.killedWith.push(sig ?? 'default');
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
  /** claude -> host */
  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
  controls(subtype: string): Record<string, any>[] {
    return this.written.filter((w) => w.type === 'control_request' && w.request?.subtype === subtype);
  }
  responses(): Record<string, any>[] {
    return this.written.filter((w) => w.type === 'control_response');
  }
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timed out');
    await tick(5);
  }
}

/** Plays the child's side of the control protocol: answers get_settings/set_model/apply_flag_settings. */
function autoControl(child: FakeChild, applied: { model: string; effort: string }): void {
  const seen = new Set<string>();
  const iv = setInterval(() => {
    for (const w of child.written) {
      if (w.type !== 'control_request' || seen.has(w.request_id)) continue;
      seen.add(w.request_id);
      const sub = w.request.subtype;
      let payload: Record<string, unknown> = {};
      if (sub === 'set_model') {
        applied.model = `claude-${w.request.model}-5-5`;
        payload = { model: applied.model };
      } else if (sub === 'apply_flag_settings') {
        applied.effort = w.request.settings.effortLevel;
      } else if (sub === 'get_settings') {
        payload = { applied: { ...applied } };
      } else continue;
      child.emitLine({ type: 'control_response', response: { subtype: 'success', request_id: w.request_id, response: payload } });
    }
  }, 5);
  child.once('exit', () => clearInterval(iv));
  // keep the interval from holding vitest open
  iv.unref();
}

function mkSession(child = new FakeChild(), extra: Partial<ConstructorParameters<typeof RunnerSession>[0]> = {}) {
  const session = new RunnerSession({ sessionId: 'sess-1', cwd: 'C:\\x', child, model: 'haiku', effort: 'high', ...extra });
  const states: RunnerState[] = [];
  session.on('change', (s: RunnerState) => states.push(s));
  return { child, session, states };
}

describe('RunnerSession protocol', () => {
  const replay = (child: FakeChild, text: string) =>
    child.emitLine({ type: 'user', message: { role: 'user', content: text }, isReplay: true });

  it('writes user messages as stream-json; follow-ups queue until the child replays them; a merged turn ends with ONE result', async () => {
    const { child, session } = mkSession();
    session.sendUser('first');
    session.sendUser('follow-up 1');
    session.sendUser('follow-up 2');
    await until(() => child.written.length === 3);
    expect(child.written[0]).toEqual({ type: 'user', message: { role: 'user', content: 'first' } });
    expect(child.written[2].message.content).toBe('follow-up 2');
    expect(session.state()).toMatchObject({ busy: true, queued: 3 });

    replay(child, 'first');
    await until(() => session.state().queued === 2);
    // claude merges the other two into the running turn and replays them
    replay(child, 'follow-up 1');
    replay(child, 'follow-up 2');
    await until(() => session.state().queued === 0);
    expect(session.state().busy).toBe(true);
    // a tool_result echo is not a replay
    child.emitLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } });
    child.emitLine({ type: 'result', subtype: 'success' });
    await until(() => !session.state().busy);
    expect(session.state().queued).toBe(0);
  });

  it('a result with messages still unconsumed stays busy, then continues with the next turn', async () => {
    const { child, session } = mkSession();
    session.sendUser('a');
    replay(child, 'a');
    session.sendUser('b'); // arrives after the turn already passed the point where it could merge
    child.emitLine({ type: 'result', subtype: 'success' });
    await tick(30);
    expect(session.state()).toMatchObject({ busy: true, queued: 1 });
    replay(child, 'b');
    child.emitLine({ type: 'result', subtype: 'success' });
    await until(() => !session.state().busy);
  });

  it('if a replay never arrives, busy clears after the settle time', async () => {
    const { child, session } = mkSession(new FakeChild(), { settleMs: 40 });
    session.sendUser('a');
    session.sendUser('lost');
    replay(child, 'a');
    child.emitLine({ type: 'result', subtype: 'success' });
    await until(() => !session.state().busy, 1000);
    expect(session.state().queued).toBe(0);
  });

  it('handles lines split across chunks and ignores non-JSON noise', async () => {
    const { child, session } = mkSession();
    session.sendUser('x');
    replay(child, 'x');
    child.stdout.write('not json\n{"type":"res');
    child.stdout.write('ult"}\n');
    await until(() => !session.state().busy);
  });

  it('confirms model and effort from get_settings on init', async () => {
    const { child, session } = mkSession();
    autoControl(child, { model: 'claude-haiku-5-5', effort: 'high' });
    child.emitLine({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' });
    await until(() => session.state().confirmed);
    expect(session.state()).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high', confirmed: true });
  });

  it('set_model sends only the set_model control request, then reads back get_settings', async () => {
    const { child, session } = mkSession();
    autoControl(child, { model: 'claude-haiku-5-5', effort: 'high' });
    const r = await session.setModel('sonnet');
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(child.controls('set_model')[0].request).toEqual({ subtype: 'set_model', model: 'sonnet' });
    expect(child.controls('get_settings')).toHaveLength(1);
    // one mechanism only: no /model text message
    expect(child.written.some((w) => w.type === 'user')).toBe(false);
    expect(session.state()).toMatchObject({ model: 'claude-sonnet-5-5', confirmed: true });
  });

  it('effort uses apply_flag_settings {effortLevel} and is confirmed by get_settings', async () => {
    const { child, session } = mkSession();
    autoControl(child, { model: 'claude-haiku-5-5', effort: 'high' });
    const r = await session.setEffort('low');
    expect(child.controls('apply_flag_settings')[0].request).toEqual({
      subtype: 'apply_flag_settings',
      settings: { effortLevel: 'low' },
    });
    expect(r.effort).toBe('low');
    expect(session.state().effort).toBe('low');
  });

  it('a failing control request rejects and a silent child times out', async () => {
    const { child, session } = mkSession(new FakeChild(), { controlTimeoutMs: 60 });
    const p = session.control('set_model', { model: 'nope' });
    await until(() => child.controls('set_model').length === 1);
    child.emitLine({
      type: 'control_response',
      response: { subtype: 'error', request_id: child.controls('set_model')[0].request_id, error: 'bad model' },
    });
    await expect(p).rejects.toThrow('bad model');
    await expect(session.control('get_settings')).rejects.toThrow('timed out');
  });

  const writeReq = {
    type: 'control_request',
    request_id: 'req-w1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input: { file_path: 'C:\\x\\a.txt', content: 'hi' },
      description: 'a.txt',
      tool_use_id: 'toolu_1',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    },
  };

  it('holds a can_use_tool request and never answers it on its own', async () => {
    const { child, session } = mkSession();
    session.sendUser('write a file');
    child.emitLine(writeReq);
    await until(() => session.state().pending.length === 1);
    await tick(80);
    const p = session.state().pending[0];
    expect(p).toMatchObject({ requestId: 'req-w1', toolName: 'Write', kind: 'permission', toolUseId: 'toolu_1' });
    expect(p.inputPreview).toContain('a.txt');
    expect(p).toMatchObject({ label: 'เขียนไฟล์: a.txt', detail: 'a.txt' });
    expect(child.responses()).toHaveLength(0);
  });

  it('allow replies with the exact control_response shape and the original input', async () => {
    const { child, session } = mkSession();
    session.sendUser('write');
    child.emitLine(writeReq);
    await until(() => session.state().pending.length === 1);
    session.answer('req-w1', 'allow');
    expect(child.responses()[0]).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-w1',
        response: { behavior: 'allow', updatedInput: { file_path: 'C:\\x\\a.txt', content: 'hi' } },
      },
    });
    expect(session.state().pending).toHaveLength(0);
  });

  it('deny replies with behavior deny and a message', async () => {
    const { child, session } = mkSession();
    session.sendUser('write');
    child.emitLine(writeReq);
    await until(() => session.state().pending.length === 1);
    session.answer('req-w1', 'deny');
    expect(child.responses()[0].response).toEqual({
      subtype: 'success',
      request_id: 'req-w1',
      response: { behavior: 'deny', message: 'User denied this from the control room' },
    });
    session.sendUser('again');
    child.emitLine({ ...writeReq, request_id: 'req-w2' });
    await until(() => session.state().pending.length === 1);
    session.answer('req-w2', 'deny', undefined, 'nope');
    expect(child.responses()[1].response.response).toEqual({ behavior: 'deny', message: 'nope' });
  });

  it('rejects an answer for an unknown request id', () => {
    const { session } = mkSession();
    expect(() => session.answer('missing', 'allow')).toThrow('no such pending request');
  });

  it('AskUserQuestion becomes an ask item with options and the answer goes in updatedInput.answers', async () => {
    const { child, session } = mkSession();
    session.sendUser('ask me');
    const questions = [
      {
        question: 'Which colour do you prefer?',
        header: 'Colour',
        multiSelect: false,
        options: [
          { label: 'Red', description: 'Choose Red' },
          { label: 'Green', description: 'Choose Green' },
        ],
      },
    ];
    child.emitLine({
      type: 'control_request',
      request_id: 'req-q1',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions }, tool_use_id: 'toolu_q', requires_user_interaction: true },
    });
    await until(() => session.state().pending.length === 1);
    const p = session.state().pending[0];
    expect(p.kind).toBe('ask');
    expect(p.questions?.[0].options.map((o) => o.label)).toEqual(['Red', 'Green']);
    session.answer('req-q1', 'allow', { 'Which colour do you prefer?': 'Green' });
    expect(child.responses()[0]).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-q1',
        response: { behavior: 'allow', updatedInput: { questions, answers: { 'Which colour do you prefer?': 'Green' } } },
      },
    });
  });

  it('a control_cancel_request drops the held item', async () => {
    const { child, session } = mkSession();
    session.sendUser('x');
    child.emitLine(writeReq);
    await until(() => session.state().pending.length === 1);
    child.emitLine({ type: 'control_cancel_request', request_id: 'req-w1' });
    await until(() => session.state().pending.length === 0);
  });

  it('answers an unknown host request with an error, never with allow', async () => {
    const { child } = mkSession();
    child.emitLine({ type: 'control_request', request_id: 'r9', request: { subtype: 'mystery' } });
    await until(() => child.responses().length === 1);
    expect(child.responses()[0].response).toMatchObject({ subtype: 'error', request_id: 'r9' });
  });

  it('stop sends interrupt; the child is left alone when the turn ends in time', async () => {
    const { child, session } = mkSession(new FakeChild(), { stopGraceMs: 80 });
    session.sendUser('long job');
    session.stop();
    expect(child.controls('interrupt')).toHaveLength(1);
    child.emitLine({ type: 'result', subtype: 'error_during_execution' });
    await tick(150);
    expect(child.killedWith).toHaveLength(0);
    expect(session.state().alive).toBe(true);
  });

  it('stop kills exactly this child when the turn does not end after the interrupt', async () => {
    const { child, session } = mkSession(new FakeChild(), { stopGraceMs: 40 });
    session.sendUser('stuck job');
    session.stop();
    await until(() => !session.state().alive);
    expect(child.killedWith).toHaveLength(1);
    expect(session.state()).toMatchObject({ alive: false, busy: false });
    expect(() => session.sendUser('late')).toThrow('process has ended');
  });

  it('process exit clears pending items and records a failure reason', async () => {
    const { child, session } = mkSession();
    session.sendUser('x');
    child.emitLine(writeReq);
    await until(() => session.state().pending.length === 1);
    child.stderr.write('boom happened');
    await tick(10);
    child.emit('exit', 1, null);
    await until(() => !session.state().alive);
    expect(session.state().pending).toHaveLength(0);
    expect(session.state().error).toContain('code=1');
    expect(session.state().error).toContain('boom happened');
  });
});

describe('Runner manager', () => {
  let tmp: string;
  let children: FakeChild[];
  let calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-runner-'));
    children = [];
    calls = [];
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkRunner = (extra: Record<string, unknown> = {}) =>
    new Runner({
      allowedCwds: () => [tmp],
      spawn: (cmd, args, o) => {
        const c = new FakeChild();
        children.push(c);
        calls.push({ cmd, args, cwd: o.cwd, env: o.env });
        return c;
      },
      ...extra,
    });

  it('start spawns claude with the stream-json flags, session id, model, effort and prompt prompt tool', async () => {
    const r = mkRunner();
    const id = r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'hello' });
    const a = calls[0].args;
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].cwd).toBe(tmp);
    for (const flag of ['-p', '--verbose', '--include-partial-messages']) expect(a).toContain(flag);
    const val = (f: string) => a[a.indexOf(f) + 1];
    expect(val('--input-format')).toBe('stream-json');
    expect(val('--output-format')).toBe('stream-json');
    expect(val('--permission-prompt-tool')).toBe('stdio');
    expect(a).toContain('--replay-user-messages');
    expect(val('--permission-mode')).toBe('default');
    expect(val('--model')).toBe('haiku');
    expect(val('--effort')).toBe('high');
    expect(a).toContain('--chrome'); // web jobs get Claude in Chrome like terminal sessions
    expect(val('--session-id')).toBe(id);
    expect(a).not.toContain('--dangerously-skip-permissions');
    await until(() => children[0].written.length === 1);
    expect(children[0].written[0]).toEqual({ type: 'user', message: { role: 'user', content: 'hello' } });
    expect(r.states()[0]).toMatchObject({ sessionId: id, alive: true, busy: true, cwd: tmp });
  });

  it('extraEnv reaches only its own child; a normal start gets none; a re-launch in this process keeps it; the key is in no args or messages', () => {
    const KEY = 'sk_test_0000000000000000';
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const r = mkRunner({ goneKeepMs: 60_000 });
      const clip = r.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'brief' }, { trustedCwd: true, extraEnv: { ELEVENLABS_API_KEY: KEY } });
      r.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'hi' });
      expect(calls[0].env.ELEVENLABS_API_KEY).toBe(KEY);
      expect(calls[1].env).not.toHaveProperty('ELEVENLABS_API_KEY');
      expect(JSON.stringify(calls[0].args)).not.toContain(KEY);
      expect(JSON.stringify(children[0].written)).not.toContain(KEY);
      children[0].emit('exit', 0, null); // the clip job ends, then is resumed in this process
      r.adopt({ sessionId: clip, cwd: tmp });
      expect(calls[2].env.ELEVENLABS_API_KEY).toBe(KEY);
    } finally {
      if (saved === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = saved;
    }
  });

  it('an ended job leaves states() after goneKeepMs and emits "removed"; a live idle job stays; a resumed one is kept', async () => {
    const r = mkRunner({ goneKeepMs: 40 });
    const removed: string[] = [];
    r.on('removed', (id: string) => removed.push(id));
    const dead = r.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    const idle = r.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'y' });
    children[0].emit('exit', 0, null);
    expect(r.states().find((s) => s.sessionId === dead)?.alive).toBe(false);
    await until(() => removed.includes(dead));
    await new Promise((res) => setTimeout(res, 80));
    expect(r.states().map((s) => s.sessionId)).toEqual([idle]);
    expect(removed).toEqual([dead]);
    // resumed before the timer fires: the new child must survive the old timer
    children[1].emit('exit', 0, null);
    r.adopt({ sessionId: idle, cwd: tmp });
    await new Promise((res) => setTimeout(res, 100));
    expect(r.states().map((s) => s.sessionId)).toEqual([idle]);
    expect(r.isAlive(idle)).toBe(true);
    expect(removed).toEqual([dead]);
  });

  it('close() ends stdin and removes the job at once when the child exits; a job that exits by itself still waits goneKeepMs', async () => {
    const r = mkRunner({ goneKeepMs: 60_000 });
    const removed: [string, unknown][] = [];
    r.on('removed', (id: string, info: unknown) => removed.push([id, info]));
    const closed = r.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    const selfEnded = r.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'y' });
    r.close(closed);
    await until(() => children[0].stdin.writableEnded);
    expect(r.states().find((s) => s.sessionId === closed)?.alive).toBe(true); // still running until the child exits
    children[0].emit('exit', 0, null);
    expect(r.has(closed)).toBe(false);
    expect(removed).toEqual([[closed, { closed: true }]]);
    expect(r.states().map((s) => s.sessionId)).toEqual([selfEnded]);

    children[1].emit('exit', 0, null);
    await tick(20);
    expect(r.has(selfEnded)).toBe(true); // the usual grace period applies
    expect(removed).toHaveLength(1);
  });

  it('close() on an unknown or ended job is refused like stop()', () => {
    const r = mkRunner();
    expect(() => r.close('nobody')).toThrow(CommandError);
    const id = r.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    children[0].emit('exit', 0, null);
    expect(() => r.close(id)).toThrow('process has ended');
    expect(() => r.stop(id)).toThrow(CommandError);
  });

  it('a job closed and then resumed under the same id is not removed by the closed exit', async () => {
    const r = mkRunner({ goneKeepMs: 20 });
    const removed: string[] = [];
    r.on('removed', (id: string) => removed.push(id));
    const id = r.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    r.close(id);
    children[0].emit('exit', 0, null);
    expect(r.has(id)).toBe(false);
    r.adopt({ sessionId: id, cwd: tmp });
    await tick(60);
    expect(r.isAlive(id)).toBe(true);
    expect(removed).toEqual([id]); // the removal of the closed job only; the resumed one is live
  });

  it('rejects a cwd that is not on the whitelist, and unlaunchable models', () => {
    const r = mkRunner();
    expect(() => r.start({ cwd: path.join(tmp, '..'), model: 'haiku', effort: 'high', prompt: 'x' })).toThrow(CommandError);
    expect(() => r.start({ cwd: 'C:\\Windows', model: 'haiku', effort: 'high', prompt: 'x' })).toThrow('cwd not allowed');
    expect(() => r.start({ cwd: tmp, model: 'qwen', effort: 'high', prompt: 'x' })).toThrow('model not available');
    expect(calls).toHaveLength(0);
  });

  it('accepts a whitelisted cwd spelled differently (case / trailing slash)', () => {
    const r = mkRunner();
    const spelled = process.platform === 'win32' ? tmp.toUpperCase() + path.sep : tmp + path.sep;
    r.start({ cwd: spelled, model: 'haiku', effort: 'low', prompt: 'x' });
    expect(calls[0].cwd).toBe(tmp);
  });

  it('strips CLAUDE* variables from the child environment', () => {
    const env = childEnv({ PATH: '/bin', CLAUDE_CODE_SESSION_ID: 'x', ClaudeFoo: 'y', ANTHROPIC_FOO: 'keep' });
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_FOO: 'keep' });
  });

  it('extra args are appended; unknown session ids are refused', () => {
    const r = mkRunner({ extraArgs: ['--setting-sources', 'project,local'] });
    r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'x' });
    expect(calls[0].args.slice(-2)).toEqual(['--setting-sources', 'project,local']);
    expect(() => r.send('nope', 'x')).toThrow('unknown session');
    expect(() => r.stop('nope')).toThrow('unknown session');
  });

  it('follow-up send, setModel, setEffort, answer and stop go to the right child', async () => {
    const r = mkRunner();
    const a = r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'one' });
    const b = r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'other' });
    autoControl(children[0], { model: 'claude-haiku-5-5', effort: 'high' });
    r.send(a, 'two');
    await until(() => children[0].written.length === 2);
    expect(children[1].written).toHaveLength(1);
    expect((await r.setModel(a, 'sonnet')).model).toBe('claude-sonnet-5-5');
    expect((await r.setEffort(a, 'max')).effort).toBe('max');
    children[1].emitLine({
      type: 'control_request',
      request_id: 'p1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't' },
    });
    await until(() => r.states().find((s) => s.sessionId === b)!.pending.length === 1);
    expect(() => r.answer(a, 'p1', 'allow')).toThrow('no such pending request');
    r.answer(b, 'p1', 'allow');
    expect(children[1].responses()).toHaveLength(1);
    r.stop(a);
    expect(children[0].controls('interrupt')).toHaveLength(1);
    expect(children[1].controls('interrupt')).toHaveLength(0);
  });

  it('adopt resumes with --resume <id>, refuses while the Runner child is alive, and reuses the id after exit', async () => {
    const r = mkRunner();
    const sid = 'aaaaaaaa-1111-4222-8333-444444444444';
    r.adopt({ sessionId: sid, cwd: tmp, model: 'haiku', effort: 'low' });
    const a = calls[0].args;
    expect(a[a.indexOf('--resume') + 1]).toBe(sid);
    expect(a).not.toContain('--session-id');
    expect(() => r.adopt({ sessionId: sid, cwd: tmp })).toThrow('already controlled');
    children[0].emit('exit', 0, null);
    await until(() => !r.isAlive(sid));
    r.adopt({ sessionId: sid, cwd: tmp, rawModel: 'claude-opus-5-5' });
    expect(calls[1].args[calls[1].args.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(() => r.adopt({ sessionId: 'bad id!', cwd: tmp })).toThrow('bad session id');
  });

  it('shutdown kills every child by its own handle', () => {
    const r = mkRunner();
    r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'x' });
    r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'y' });
    r.shutdown();
    expect(children.map((c) => c.killedWith.length)).toEqual([1, 1]);
  });
});

describe('command schema', () => {
  const ok = (m: unknown) => parseClientMsg(m);
  it('accepts valid commands', () => {
    expect(ok({ type: 'start', reqId: 'r1', cwd: 'C:\\a', model: 'haiku', effort: 'high', prompt: 'hi' }).ok).toBe(true);
    expect(ok({ type: 'send', reqId: 'r1', sessionId: 'abc-123', text: 'hi' }).ok).toBe(true);
    expect(ok({ type: 'answer', reqId: 'r1', sessionId: 'abc', requestId: 'q1', behavior: 'allow', answers: { q: 'a' } }).ok).toBe(true);
    expect(ok({ type: 'adopt', reqId: 'r1', sessionId: 'abc' }).ok).toBe(true);
  });
  it('rejects bad shapes', () => {
    const bad = (m: unknown) => expect(ok(m).ok).toBe(false);
    bad(null);
    bad([]);
    bad({ type: 'start' });
    bad({ type: 'nope', reqId: 'r' });
    bad({ type: 'send', reqId: 'r', sessionId: '../x', text: 'hi' });
    bad({ type: 'send', reqId: 'r', sessionId: 'abc', text: '   ' });
    bad({ type: 'send', reqId: 'r', sessionId: 'abc', text: 'x'.repeat(20001) });
    bad({ type: 'start', reqId: 'r', cwd: 'C:\\a', model: 'qwen', effort: 'high', prompt: 'x' }); // disabled
    bad({ type: 'start', reqId: 'r', cwd: 'C:\\a', model: 'haiku', effort: 'ultra', prompt: 'x' });
    bad({ type: 'set_model', reqId: 'r', sessionId: 'abc', model: 'tokenme-qwen' });
    bad({ type: 'answer', reqId: 'r', sessionId: 'abc', requestId: 'q', behavior: 'maybe' });
    bad({ type: 'answer', reqId: 'r', sessionId: 'abc', requestId: 'q', behavior: 'allow', answers: { q: 5 } });
    bad({ type: 'stop', sessionId: 'abc' }); // no reqId
  });
});

describe('known cwds', () => {
  it('merges session cwds and ~/.claude.json project roots under home, dedups, drops temp and missing dirs', () => {
    const home = fs.mkdtempSync(path.join(process.cwd(), 'tmp-home-')); // not under the OS temp dir (session cwds there are filtered)
    try {
      const proj = path.join(home, 'proj');
      const sess = path.join(home, 'sess');
      fs.mkdirSync(proj);
      fs.mkdirSync(sess);
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-out-'));
      fs.writeFileSync(
        path.join(home, '.claude.json'),
        JSON.stringify({ oauthAccount: { secret: 'x' }, projects: { [proj]: {}, [outside]: {}, [path.join(home, 'gone')]: {} } }),
      );
      const scratch = path.join(home, 'AppData', 'Local', 'Temp', 'scratch');
      fs.mkdirSync(scratch, { recursive: true });
      const list = knownCwds({ sessionCwds: () => [sess, sess.toUpperCase(), path.join(home, 'nodir'), scratch], home });
      expect(list.map(normPath).sort()).toEqual([normPath(proj), normPath(sess)].sort());
      fs.rmSync(outside, { recursive: true, force: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

const CLIP_SID = 'clip-sess-0001';

describe('WebSocket commands', () => {
  let tmp: string;
  let watcherRoot: string;
  let server: RunningServer | null = null;
  let watcher: Watcher | null = null;
  let children: FakeChild[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ws-'));
    watcherRoot = path.join(tmp, 'claude');
    fs.mkdirSync(path.join(watcherRoot, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(watcherRoot, 'projects'), { recursive: true });
    children = [];
  });
  afterEach(async () => {
    watcher?.stop();
    await server?.close();
    watcher = null;
    server = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** withClip: also wires a ClipService with one stored clip job (session CLIP_SID, folder tmp/videos/clip-one). */
  async function boot(withRunner = true, withClip = false) {
    const work = path.join(tmp, 'work');
    fs.mkdirSync(work);
    watcher = new Watcher({ claudeDir: watcherRoot, pollMs: 50, isPidAlive: (pid) => pid === 1111 });
    watcher.start();
    const runner = withRunner
      ? new Runner({
          allowedCwds: () => [work],
          spawn: () => {
            const c = new FakeChild();
            children.push(c);
            return c;
          },
        })
      : undefined;
    let clips: ClipService | undefined;
    if (withClip && runner) {
      const videos = path.join(tmp, 'videos');
      const clipCwd = path.join(videos, 'clip-one');
      fs.mkdirSync(clipCwd, { recursive: true });
      const db = new WorklogDb(':memory:');
      db.insertClip({
        sessionId: CLIP_SID, topic: 't', slug: 'clip-one', cwd: clipCwd, styleId: 'ours:whiteboard', styleName: 'Whiteboard',
        settings: { length: '30s', ratio: '9:16', lang: 'th', voice: false, music: false, cast: [] }, voiceId: null,
        scriptModel: 'sonnet', builderModel: 'haiku', createdAt: 1700000000000, stage: 1, ready: false, renderRequested: false,
      });
      clips = new ClipService({
        db, runner, sessions: () => watcher!.snapshot(), lemo: () => ({ installed: false, styles: [], categories: [] }), videosDir: videos,
      });
    }
    const logDir = path.join(tmp, 'data');
    server = await startServer({
      watcher,
      port: 0,
      pingMs: 100000,
      runner,
      clips,
      allowedCwds: () => [work],
      log: fileLogger(logDir),
      isPidAlive: (pid) => pid === 1111,
    });
    return { work, logDir, runner };
  }

  function connect(origin?: string): Promise<{ ws: WebSocket; msgs: ServerMsg[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}`, origin ? { origin } : undefined);
      const msgs: ServerMsg[] = [];
      ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
      ws.on('open', () => resolve({ ws, msgs }));
      ws.on('error', reject);
    });
  }

  const ackFor = async (msgs: ServerMsg[], reqId: string) => {
    await until(() => msgs.some((m) => m.type === 'ack' && m.reqId === reqId));
    return msgs.find((m) => m.type === 'ack' && m.reqId === reqId) as Extract<ServerMsg, { type: 'ack' }>;
  };

  it('start -> runner state broadcast -> follow-up; invalid and unknown commands are refused; log has no prompt text', async () => {
    const { work, logDir } = await boot();
    const { ws, msgs } = await connect('http://localhost:5173');
    await until(() => msgs.some((m) => m.type === 'snapshot'));
    const snap = msgs.find((m) => m.type === 'snapshot') as Extract<ServerMsg, { type: 'snapshot' }>;
    expect(snap.cwds).toEqual([work]);

    ws.send(JSON.stringify({ type: 'start', reqId: 's1', cwd: work, model: 'haiku', effort: 'high', prompt: 'SECRET-PROMPT-TEXT' }));
    const ack = await ackFor(msgs, 's1');
    expect(ack.ok).toBe(true);
    const sid = ack.sessionId!;
    await until(() => msgs.some((m) => m.type === 'runner' && m.runner.sessionId === sid && m.runner.busy));
    expect(children[0].written[0].message.content).toBe('SECRET-PROMPT-TEXT');

    ws.send(JSON.stringify({ type: 'send', reqId: 's2', sessionId: sid, text: 'more' }));
    expect((await ackFor(msgs, 's2')).ok).toBe(true);
    await until(() => children[0].written.length === 2);

    ws.send(JSON.stringify({ type: 'send', reqId: 's3', sessionId: 'unknown-id', text: 'more' }));
    const a3 = await ackFor(msgs, 's3');
    expect(a3.ok).toBe(false);
    expect(a3.error).toContain('unknown session');

    ws.send(JSON.stringify({ type: 'start', reqId: 's4', cwd: 'C:\\Windows', model: 'haiku', effort: 'high', prompt: 'x' }));
    expect((await ackFor(msgs, 's4')).error).toContain('cwd not allowed');
    ws.send(JSON.stringify({ type: 'bogus', reqId: 's5' }));
    expect((await ackFor(msgs, 's5')).ok).toBe(false);
    ws.send('not json');
    await until(() => msgs.some((m) => m.type === 'ack' && !m.ok && m.error === 'invalid JSON'));
    ws.close();

    const log = fs.readFileSync(path.join(logDir, 'commands.log'), 'utf8');
    expect(log).toContain('"cmd":"start"');
    expect(log).toContain('"promptChars":18');
    expect(log).toContain('"origin":"http://localhost:5173"');
    expect(log).not.toContain('SECRET-PROMPT-TEXT');
  });

  it('permission mode over the socket: bypass without confirm is refused, a start with a mode is logged and spawns with it', async () => {
    const { work, logDir } = await boot();
    const { ws, msgs } = await connect();
    const base = { type: 'start', cwd: work, model: 'haiku', effort: 'low', prompt: 'p' };
    ws.send(JSON.stringify({ ...base, reqId: 'm1', permissionMode: 'bypassPermissions' }));
    const a1 = await ackFor(msgs, 'm1');
    expect(a1.ok).toBe(false);
    expect(a1.error).toContain('confirm');
    expect(children).toHaveLength(0);
    ws.send(JSON.stringify({ ...base, reqId: 'm2', permissionMode: 'acceptEdits' }));
    expect((await ackFor(msgs, 'm2')).ok).toBe(true);
    expect(children).toHaveLength(1);
    ws.send(JSON.stringify({ type: 'set_permission_mode', reqId: 'm3', sessionId: 'nobody', mode: 'plan' }));
    expect((await ackFor(msgs, 'm3')).error).toContain('unknown session');
    ws.close();
    const log = fs.readFileSync(path.join(logDir, 'commands.log'), 'utf8');
    expect(log).toContain('"permissionMode":"acceptEdits"');
    expect(log).toContain('"cmd":"set_permission_mode"');
  });

  it('a foreign Origin cannot connect at all', async () => {
    await boot();
    await expect(connect('http://evil.example')).rejects.toThrow();
  });

  it('refuses commands when no runner is configured', async () => {
    await boot(false);
    const { ws, msgs } = await connect();
    ws.send(JSON.stringify({ type: 'stop', reqId: 'x1', sessionId: 'abc' }));
    expect((await ackFor(msgs, 'x1')).error).toBe('runner is not enabled');
    ws.close();
  });

  it('adopt: refused for an unknown id and while the terminal process lives; allowed once it is gone', async () => {
    const { work } = await boot();
    const mk = (pid: number, sid: string) => {
      fs.writeFileSync(
        path.join(watcherRoot, 'sessions', `${pid}.json`),
        JSON.stringify({ pid, sessionId: sid, cwd: work, name: `n${pid}`, kind: 'interactive', startedAt: 1700000000000 }),
      );
    };
    mk(1111, 'live-session');
    mk(2222, 'dead-session');
    await until(() => watcher!.snapshot().length === 2);
    const { ws, msgs } = await connect();

    ws.send(JSON.stringify({ type: 'adopt', reqId: 'a1', sessionId: 'nobody' }));
    expect((await ackFor(msgs, 'a1')).error).toBe('unknown session id');
    ws.send(JSON.stringify({ type: 'adopt', reqId: 'a2', sessionId: 'live-session' }));
    expect((await ackFor(msgs, 'a2')).error).toContain('still running');
    expect(children).toHaveLength(0);

    ws.send(JSON.stringify({ type: 'adopt', reqId: 'a3', sessionId: 'dead-session', model: 'haiku' }));
    expect((await ackFor(msgs, 'a3')).ok).toBe(true);
    expect(children).toHaveLength(1);
    ws.close();
  });

  it('clip job adopt: found in the clip store (no watcher session), resumed in its trusted folder outside the whitelist', async () => {
    const { runner } = await boot(true, true);
    const { ws, msgs } = await connect();
    ws.send(JSON.stringify({ type: 'adopt', reqId: 'c1', sessionId: CLIP_SID }));
    const ack = await ackFor(msgs, 'c1');
    expect(ack.ok).toBe(true);
    expect(ack.sessionId).toBe(CLIP_SID);
    expect(children).toHaveLength(1);
    const st = runner!.states().find((s) => s.sessionId === CLIP_SID)!;
    expect(st.alive).toBe(true);
    expect(st.cwd).toBe(path.join(tmp, 'videos', 'clip-one'));
    expect(st.model).toBe('haiku'); // the job's builderModel when the message names none
    expect(st.effort).toBe('high');
    ws.close();
  });

  it('close is validated and routed: a closed job is removed at once (runner_removed); an unknown id is refused', async () => {
    expect(parseClientMsg({ type: 'close', reqId: 'c0', sessionId: 's-1' })).toEqual({ ok: true, msg: { type: 'close', reqId: 'c0', sessionId: 's-1' } });
    expect(parseClientMsg({ type: 'close', reqId: 'c0', sessionId: '../x' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'close', reqId: 'c0' }).ok).toBe(false);

    const { work, logDir, runner } = await boot();
    const { ws, msgs } = await connect();
    await until(() => msgs.some((m) => m.type === 'snapshot'));
    ws.send(JSON.stringify({ type: 'start', reqId: 'k1', cwd: work, model: 'haiku', effort: 'low', prompt: 'p' }));
    const sid = (await ackFor(msgs, 'k1')).sessionId!;
    ws.send(JSON.stringify({ type: 'close', reqId: 'k2', sessionId: sid }));
    expect((await ackFor(msgs, 'k2')).ok).toBe(true);
    await until(() => children[0].stdin.writableEnded);
    children[0].emit('exit', 0, null);
    await until(() => msgs.some((m) => m.type === 'runner_removed' && m.sessionId === sid));
    expect(runner!.has(sid)).toBe(false);
    ws.send(JSON.stringify({ type: 'close', reqId: 'k3', sessionId: 'unknown-id' }));
    expect((await ackFor(msgs, 'k3')).error).toContain('unknown session');
    ws.close();
    expect(fs.readFileSync(path.join(logDir, 'commands.log'), 'utf8')).toContain('"cmd":"close"');
  });

  it('unknown session id is still refused when neither the watcher nor the clip store has it', async () => {
    await boot(true, true);
    const { ws, msgs } = await connect();
    ws.send(JSON.stringify({ type: 'adopt', reqId: 'u1', sessionId: 'nobody-at-all' }));
    expect((await ackFor(msgs, 'u1')).error).toBe('unknown session id');
    expect(children).toHaveLength(0);
    ws.close();
  });

  it('clip job adopt is refused while that session is already running under the Runner', async () => {
    await boot(true, true);
    const { ws, msgs } = await connect();
    ws.send(JSON.stringify({ type: 'adopt', reqId: 'r1', sessionId: CLIP_SID }));
    expect((await ackFor(msgs, 'r1')).ok).toBe(true);
    ws.send(JSON.stringify({ type: 'adopt', reqId: 'r2', sessionId: CLIP_SID }));
    const second = await ackFor(msgs, 'r2');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already controlled');
    expect(children).toHaveLength(1);
    ws.close();
  });
});

describe('RunnerSession usage limit', () => {
  const limitMsg = { type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 1:30pm (Asia/Bangkok)" }] } };

  it('a limit error on the stream sets state.limit; the next normal answer clears it', async () => {
    const { child, session } = mkSession();
    child.emitLine(limitMsg);
    await until(() => session.state().limit !== undefined);
    expect(session.state().limit?.text).toContain('5-hour limit');
    child.emitLine({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'back' }] } });
    await until(() => session.state().limit === undefined);
  });

  it('a result with is_error and limit text also sets it; a non-limit error does not', async () => {
    const a = mkSession();
    a.child.emitLine({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your weekly limit · resets Mon" });
    await until(() => a.session.state().limit !== undefined);
    const b = mkSession();
    b.child.emitLine({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500' });
    await tick(30);
    expect(b.session.state().limit).toBeUndefined();
  });
});
