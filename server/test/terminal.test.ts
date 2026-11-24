// open_terminal: command validation, argument building (no shell string), wt.exe -> cmd fallback, and the WS command.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerMsg } from '../../shared/protocol';
import { parseClientMsg } from '../src/commands';
import { startServer, type RunningServer } from '../src/index';
import { Runner, type ChildLike } from '../src/runner';
import { TITLE_MAX, TerminalLauncher, buildCmdLaunch, buildWtLaunch, cleanTitle, crCommand, defaultCliEntry, type TerminalRequest } from '../src/terminal';
import { Watcher } from '../src/watcher';

const SID = '123e4567-e89b-42d3-a456-426614174000';
const req = (over: Partial<TerminalRequest> = {}): TerminalRequest => ({ sessionId: SID, title: 'งานทดสอบ', cwd: 'C:\\Users\\x\\proj', ...over });
const cmd = crCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\cr\\cli\\src\\cr.ts', SID, 8790);

describe('open_terminal command', () => {
  it('accepts a strict uuid only', () => {
    expect(parseClientMsg({ type: 'open_terminal', reqId: 'r1', sessionId: SID })).toEqual({ ok: true, msg: { type: 'open_terminal', reqId: 'r1', sessionId: SID } });
    for (const bad of ['abc', `${SID}x`, `${SID};calc`, `"${SID}"`, SID.replace(/-/g, ''), '../../x', '', 42, null]) {
      expect(parseClientMsg({ type: 'open_terminal', reqId: 'r1', sessionId: bad }).ok).toBe(false);
    }
    expect(parseClientMsg({ type: 'open_terminal', sessionId: SID }).ok).toBe(false); // reqId missing
  });
});

describe('launch arguments', () => {
  it('wt.exe: new window, title, start dir, then the cr command; every value is its own argument', () => {
    const l = buildWtLaunch(req(), cmd);
    expect(l.file).toBe('wt.exe');
    expect(l.args).toEqual(['-w', 'new', '--title', 'งานทดสอบ', '-d', 'C:\\Users\\x\\proj', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\cr\\cli\\src\\cr.ts', 'attach', SID, '--port', '8790']);
  });

  it('the title cannot inject a wt command (;) or a cmd one (& | < > ^ %), and is bounded', () => {
    expect(cleanTitle('a; new-tab calc.exe')).toBe('a new-tab calc.exe');
    expect(cleanTitle('x & del y | z > q < r ^ s %PATH% "t"')).toBe('x del y z q r s PATH t');
    expect(cleanTitle('--help')).toBe('help');
    expect(cleanTitle('line1\nline2\u0007')).toBe('line1 line2');
    expect(cleanTitle('')).toBe('Claude job');
    expect(cleanTitle(';;;')).toBe('Claude job');
    const long = cleanTitle('ก'.repeat(500));
    expect([...long].length).toBeLessThanOrEqual(TITLE_MAX);
    expect(buildWtLaunch(req({ title: 'evil; wt -w 0 cmd' }), cmd).args[3]).not.toContain(';');
  });

  it('a semicolon in the folder is escaped for wt', () => {
    expect(buildWtLaunch(req({ cwd: 'C:\\a;b' }), cmd).args[5]).toBe('C:\\a\\;b');
  });

  it('a bad session id never reaches a command line', () => {
    expect(() => buildWtLaunch(req({ sessionId: `${SID}" & calc` }), cmd)).toThrow();
    expect(() => buildCmdLaunch(req({ sessionId: 'x' }), cmd)).toThrow();
  });

  it('cmd fallback: start "<title>" /D <cwd> <command>', () => {
    const l = buildCmdLaunch(req(), cmd);
    expect(l.file).toBe('cmd.exe');
    expect(l.args.slice(0, 5)).toEqual(['/c', 'start', 'งานทดสอบ', '/D', 'C:\\Users\\x\\proj']);
    expect(l.args.slice(5)).toEqual(cmd);
  });

  it('the cr entry file exists', () => {
    expect(fs.existsSync(defaultCliEntry())).toBe(true);
  });
});

function fakeProc(outcome: 'spawn' | 'ENOENT' | 'EPERM'): ChildProcess {
  const p = new EventEmitter() as ChildProcess;
  (p as unknown as { unref: () => void }).unref = () => {};
  queueMicrotask(() => {
    if (outcome === 'spawn') p.emit('spawn');
    else p.emit('error', Object.assign(new Error(outcome), { code: outcome }));
  });
  return p;
}

describe('TerminalLauncher', () => {
  it('uses wt.exe when it starts', async () => {
    const seen: Array<[string, string[]]> = [];
    const l = new TerminalLauncher({ port: () => 8797, nodeBin: 'node', cliEntry: 'cr.ts', platform: 'win32', spawn: (f, a) => (seen.push([f, a]), fakeProc('spawn')) });
    await expect(l.open(req())).resolves.toBe('wt');
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('wt.exe');
    expect(seen[0][1].slice(-6)).toEqual(['node', 'cr.ts', 'attach', SID, '--port', '8797']);
  });

  it('falls back to cmd /c start when wt.exe is missing, and reports other failures', async () => {
    const seen: string[] = [];
    const missing = new TerminalLauncher({ port: () => 1, platform: 'win32', spawn: (f) => (seen.push(f), fakeProc(f === 'wt.exe' ? 'ENOENT' : 'spawn')) });
    await expect(missing.open(req())).resolves.toBe('cmd');
    expect(seen).toEqual(['wt.exe', 'cmd.exe']);
    const denied = new TerminalLauncher({ port: () => 1, platform: 'win32', spawn: () => fakeProc('EPERM') });
    await expect(denied.open(req())).rejects.toThrow('Windows Terminal');
    const none = new TerminalLauncher({ port: () => 1, platform: 'win32', spawn: () => fakeProc('ENOENT') });
    await expect(none.open(req())).rejects.toThrow();
  });

  it('only on Windows', async () => {
    const l = new TerminalLauncher({ port: () => 1, platform: 'linux', spawn: () => fakeProc('spawn') });
    await expect(l.open(req())).rejects.toThrow('Windows');
  });
});

// ---- through the WebSocket: Runner jobs only ----

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 77;
  kill(): boolean {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

describe('open_terminal over the WebSocket', () => {
  let tmp: string;
  let server: RunningServer | undefined;
  let watcher: Watcher | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-term-'));
  });
  afterEach(async () => {
    await server?.close();
    watcher?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const wait = async (cond: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('opens a window for a live Runner job, refuses unknown ids, and refuses without a launcher', async () => {
    const claude = path.join(tmp, '.claude');
    fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
    watcher = new Watcher({ claudeDir: claude, pollMs: 50 });
    watcher.start();
    const runner = new Runner({ allowedCwds: () => [tmp], spawn: () => new FakeChild() });
    const opened: TerminalRequest[] = [];
    server = await startServer({ watcher, port: 0, runner, terminal: { open: async (r) => (opened.push(r), 'wt') }, log: () => {} });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const msgs: ServerMsg[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on('open', () => r()));
    await wait(() => msgs.some((m) => m.type === 'snapshot'));
    const ack = async (id: string, sessionId: string) => {
      ws.send(JSON.stringify({ type: 'open_terminal', reqId: id, sessionId }));
      await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === id));
      return msgs.find((m) => m.type === 'ack' && m.reqId === id) as Extract<ServerMsg, { type: 'ack' }>;
    };
    const job = runner.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'hi' });
    expect(await ack('o1', job)).toMatchObject({ ok: true, sessionId: job });
    expect(opened).toEqual([{ sessionId: job, title: 'Claude job', cwd: tmp }]);
    // not a Runner job (a terminal session, or nothing at all)
    expect(await ack('o2', SID)).toMatchObject({ ok: false });
    expect(opened).toHaveLength(1);
    // invalid id is rejected by the schema, before anything runs
    ws.send(JSON.stringify({ type: 'open_terminal', reqId: 'o3', sessionId: 'x;calc' }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 'o3'));
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 'o3')).toMatchObject({ ok: false, error: 'sessionId invalid' });
    ws.close();
  });
});
