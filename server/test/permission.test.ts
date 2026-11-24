// Per-job permission mode and Remote Control: protocol validation, runner args, live control requests.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseClientMsg } from '../src/commands';
import { CommandError, Runner, type ChildLike } from '../src/runner';

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 777;
  written: Record<string, any>[] = [];
  private buf = '';
  /** subtype -> payload (or an Error string) the fake answers a control_request with */
  answers: Record<string, Record<string, unknown> | string> = {};
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const w = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        this.written.push(w);
        if (w.type === 'control_request') this.answer(w);
      }
    });
  }
  private answer(w: Record<string, any>): void {
    const sub = w.request.subtype as string;
    const a = this.answers[sub];
    let response: Record<string, unknown>;
    if (typeof a === 'string') response = { subtype: 'error', request_id: w.request_id, error: a };
    else response = { subtype: 'success', request_id: w.request_id, response: a ?? (sub === 'get_settings' ? { applied: {} } : {}) };
    queueMicrotask(() => this.emitLine({ type: 'control_response', response }));
  }
  kill(): boolean {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
  controls(subtype: string): Record<string, any>[] {
    return this.written.filter((w) => w.type === 'control_request' && w.request?.subtype === subtype);
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timed out');
    await tick(5);
  }
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-perm-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mk() {
  const children: FakeChild[] = [];
  const calls: string[][] = [];
  const runner = new Runner({
    allowedCwds: () => [tmp],
    spawn: (_cmd, args) => {
      calls.push(args);
      const c = new FakeChild();
      children.push(c);
      return c;
    },
  });
  return { runner, children, calls };
}
const modeOf = (args: string[]) => args[args.indexOf('--permission-mode') + 1];

describe('runner args per permission mode', () => {
  it('start without a mode = default; each allowed mode is passed through explicitly', () => {
    const { runner, calls } = mk();
    runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    expect(modeOf(calls[0])).toBe('default');
    for (const m of ['acceptEdits', 'plan', 'bypassPermissions'] as const) {
      runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x', permissionMode: m });
      expect(modeOf(calls[calls.length - 1])).toBe(m);
    }
  });

  it('every child may be switched to bypass later, but the flag that turns it on is never passed', () => {
    const { runner, calls } = mk();
    runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    expect(calls[0]).toContain('--allow-dangerously-skip-permissions');
    expect(calls[0]).not.toContain('--dangerously-skip-permissions');
  });

  it('adopt passes the mode with --resume; missing = default', () => {
    const { runner, calls } = mk();
    runner.adopt({ sessionId: 'sid-1', cwd: tmp, model: 'haiku' });
    expect(calls[0]).toContain('--resume');
    expect(modeOf(calls[0])).toBe('default');
    runner.adopt({ sessionId: 'sid-2', cwd: tmp, model: 'haiku', permissionMode: 'acceptEdits' });
    expect(modeOf(calls[1])).toBe('acceptEdits');
  });

  it('state shows the requested mode, then what the child reports in init', async () => {
    const { runner, children } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x', permissionMode: 'plan' });
    expect(runner.states()[0]).toMatchObject({ permissionMode: 'plan', remoteControl: false });
    children[0].emitLine({ type: 'system', subtype: 'init', permissionMode: 'default', model: 'claude-haiku-5-5' });
    await until(() => runner.states().find((s) => s.sessionId === id)!.permissionMode === 'default');
  });
});

describe('set_permission_mode (live control request)', () => {
  it('sends set_permission_mode and shows the mode the child answers with', async () => {
    const { runner, children } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    children[0].answers.set_permission_mode = { mode: 'acceptEdits' };
    const st = await runner.setPermissionMode(id, 'acceptEdits');
    expect(children[0].controls('set_permission_mode')[0].request).toEqual({ subtype: 'set_permission_mode', mode: 'acceptEdits' });
    expect(st.permissionMode).toBe('acceptEdits');
  });

  it('works while a turn is running (the prompt is still held)', async () => {
    const { runner, children } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    expect(runner.states()[0].busy).toBe(true);
    children[0].answers.set_permission_mode = { mode: 'plan' };
    expect((await runner.setPermissionMode(id, 'plan')).permissionMode).toBe('plan');
  });

  it('a refusal from the child leaves the mode unchanged and surfaces the reason', async () => {
    const { runner, children } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    children[0].answers.set_permission_mode = 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions';
    await expect(runner.setPermissionMode(id, 'bypassPermissions')).rejects.toThrow(/not launched/);
    expect(runner.states()[0].permissionMode).toBe('default');
  });

  it('refuses unknown modes (auto, dontAsk), unknown sessions and dead processes', async () => {
    const { runner, children } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    await expect(runner.setPermissionMode(id, 'auto' as never)).rejects.toThrow(CommandError);
    await expect(runner.setPermissionMode(id, 'dontAsk' as never)).rejects.toThrow(/invalid/);
    await expect(runner.setPermissionMode('nobody', 'plan')).rejects.toThrow(/unknown session/);
    children[0].kill();
    await until(() => !runner.isAlive(id));
    await expect(runner.setPermissionMode(id, 'plan')).rejects.toThrow(/ended/);
  });
});

describe('Remote Control', () => {
  it('set_remote_control sends remote_control {enabled} and keeps the claude.ai link; off clears it', async () => {
    const { runner, children } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    children[0].answers.remote_control = { session_url: 'https://claude.ai/code/session_abc' };
    let st = await runner.setRemoteControl(id, true);
    expect(children[0].controls('remote_control')[0].request).toEqual({ subtype: 'remote_control', enabled: true });
    expect(st).toMatchObject({ remoteControl: true, remoteUrl: 'https://claude.ai/code/session_abc' });
    children[0].answers.remote_control = {};
    st = await runner.setRemoteControl(id, false);
    expect(children[0].controls('remote_control')[1].request).toEqual({ subtype: 'remote_control', enabled: false });
    expect(st.remoteControl).toBe(false);
    expect(st.remoteUrl).toBeUndefined();
  });

  it('start with remoteControl turns it on once the child sent init', async () => {
    const { runner, children } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x', remoteControl: true });
    expect(children[0].controls('remote_control')).toHaveLength(0);
    children[0].answers.remote_control = { session_url: 'https://claude.ai/code/session_z' };
    children[0].emitLine({ type: 'system', subtype: 'init', permissionMode: 'default' });
    await until(() => runner.states().find((s) => s.sessionId === id)!.remoteControl);
    expect(children[0].controls('remote_control')).toHaveLength(1);
  });

  it('a failed enable shows the error and the badge stays off', async () => {
    const { runner, children } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x', remoteControl: true });
    children[0].answers.remote_control = 'Remote Control is disabled by policy';
    children[0].emitLine({ type: 'system', subtype: 'init' });
    await until(() => !!runner.states().find((s) => s.sessionId === id)!.error);
    expect(runner.states()[0]).toMatchObject({ remoteControl: false });
    expect(runner.states()[0].error).toContain('Remote Control');
  });

  it('bridge_state events track the link', async () => {
    const { runner, children } = mk();
    const id = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'x' });
    children[0].emitLine({ type: 'system', subtype: 'bridge_state', state: 'connected' });
    await until(() => runner.states().find((s) => s.sessionId === id)!.remoteControl);
    children[0].emitLine({ type: 'system', subtype: 'bridge_state', state: 'failed' });
    await until(() => !runner.states().find((s) => s.sessionId === id)!.remoteControl);
  });
});

describe('command validation', () => {
  const start = { type: 'start', reqId: 'r1', cwd: 'C:\\a', model: 'haiku', effort: 'high', prompt: 'hi' };
  const parse = (m: unknown) => parseClientMsg(m);

  it('start: mode optional; allowed values only; bypassPermissions needs confirm: true', () => {
    const r = parse(start);
    expect(r.ok && (r.msg as { permissionMode?: string }).permissionMode).toBeUndefined();
    for (const m of ['default', 'acceptEdits', 'plan']) expect(parse({ ...start, permissionMode: m }).ok).toBe(true);
    for (const m of ['auto', 'dontAsk', 'manual', 'x', 5, null]) expect(parse({ ...start, permissionMode: m }).ok).toBe(false);
    expect(parse({ ...start, permissionMode: 'bypassPermissions' }).ok).toBe(false);
    expect(parse({ ...start, permissionMode: 'bypassPermissions', confirm: false }).ok).toBe(false);
    expect(parse({ ...start, permissionMode: 'bypassPermissions', confirm: 'true' }).ok).toBe(false);
    const ok = parse({ ...start, permissionMode: 'bypassPermissions', confirm: true });
    expect(ok.ok && ok.msg).toMatchObject({ permissionMode: 'bypassPermissions', confirm: true });
  });

  it('confirm alone does nothing: it is not copied onto a non-bypass command', () => {
    const r = parse({ ...start, permissionMode: 'plan', confirm: true });
    expect(r.ok && 'confirm' in r.msg).toBe(false);
  });

  it('set_permission_mode: needs session + mode; bypass needs confirm', () => {
    const m = { type: 'set_permission_mode', reqId: 'r', sessionId: 'abc-1', mode: 'acceptEdits' };
    expect(parse(m).ok).toBe(true);
    expect(parse({ ...m, mode: 'auto' }).ok).toBe(false);
    expect(parse({ ...m, mode: undefined }).ok).toBe(false);
    expect(parse({ ...m, sessionId: '../x' }).ok).toBe(false);
    expect(parse({ ...m, mode: 'bypassPermissions' }).ok).toBe(false);
    expect(parse({ ...m, mode: 'bypassPermissions', confirm: true }).ok).toBe(true);
  });

  it('adopt accepts an optional mode with the same bypass rule', () => {
    const a = { type: 'adopt', reqId: 'r', sessionId: 'abc' };
    expect(parse({ ...a, permissionMode: 'acceptEdits' }).ok).toBe(true);
    expect(parse({ ...a, permissionMode: 'bypassPermissions' }).ok).toBe(false);
    expect(parse({ ...a, permissionMode: 'bypassPermissions', confirm: true }).ok).toBe(true);
  });

  it('remoteControl: boolean only; set_remote_control needs on', () => {
    expect(parse({ ...start, remoteControl: true }).ok).toBe(true);
    expect(parse({ ...start, remoteControl: 'yes' }).ok).toBe(false);
    expect(parse({ type: 'set_remote_control', reqId: 'r', sessionId: 'abc', on: true }).ok).toBe(true);
    expect(parse({ type: 'set_remote_control', reqId: 'r', sessionId: 'abc' }).ok).toBe(false);
    expect(parse({ type: 'set_remote_control', reqId: 'r', sessionId: 'abc', on: 'on' }).ok).toBe(false);
  });
});
