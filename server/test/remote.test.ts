// Remote hub (SSH tunnel + agent websocket), agent mode gating, loopback guard, token check, command forwarding.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_PORT, AGENT_TOKEN_HEADER, type ClientMsg, type RunnerState, type ServerMsg, type SessionInfo } from '../../shared/protocol';
import { agentPortFromEnv, assertLoopbackHost, headerTokenOk, isAgentMode, loadTokenHash, sha256Hex, tokenMatches } from '../src/agent';
import { parseClientMsg, routeTarget } from '../src/commands';
import { WorklogDb } from '../src/db';
import { startServer, type RunningServer } from '../src/index';
import { MachineService } from '../src/machines';
import { RemoteHub, buildTunnelArgs, directFromEnv, envTokenSource, tokenEnvName, type RemoteTarget, type TunnelChild, type WsLike } from '../src/remote';
import { Runner } from '../src/runner';
import { Watcher } from '../src/watcher';

const wait = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: id, pid: 1, name: id, cwd: 'C:\\x', kind: 'interactive', title: `t-${id}`, model: 'haiku', effort: 'low', status: 'idle', thought: '', startedAt: 1, lastActivity: 2, timeline: [], subagents: [], ...over,
});
const runnerState = (id: string): RunnerState => ({
  sessionId: id, cwd: 'C:\\x', alive: true, pid: 5, busy: false, queued: 0, model: 'haiku', effort: 'low', confirmed: true, permissionMode: 'default', remoteControl: false, pending: [], startedAt: 1,
});

// ---------- fakes ----------

class FakeWs extends EventEmitter implements WsLike {
  readyState = 1;
  sent: string[] = [];
  terminated = false;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  /** the agent says something */
  say(msg: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  lastSent(): Record<string, any> {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}
class FakeChild extends EventEmitter implements TunnelChild {
  killed = 0;
  stderr = new EventEmitter() as unknown as TunnelChild['stderr'];
  kill() {
    this.killed++;
    return true;
  }
}

const T1: RemoteTarget = { id: 'm1', name: 'server', host: '192.0.2.10', user: 'user', keyPath: '', agent: true };

interface Rig {
  hub: RemoteHub;
  machines: RemoteTarget[];
  spawns: { file: string; args: string[]; child: FakeChild }[];
  sockets: { url: string; headers: Record<string, string>; ws: FakeWs }[];
  logs: Record<string, unknown>[];
  events: string[];
  tokens: Record<string, string | null>;
}

let tmp: string;
let keyFile: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-remote-'));
  fs.mkdirSync(path.join(tmp, '.ssh'));
  keyFile = path.join(tmp, '.ssh', 'k');
  fs.writeFileSync(keyFile, 'NOT A KEY');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function rig(over: { machines?: RemoteTarget[]; direct?: { port: number } | null; tokens?: Record<string, string | null> } = {}): Rig {
  const r: Rig = { hub: null as unknown as RemoteHub, machines: over.machines ?? [{ ...T1, keyPath: keyFile }], spawns: [], sockets: [], logs: [], events: [], tokens: over.tokens ?? { m1: 'sekret-token', m2: 'other-token' } };
  let port = 40000;
  r.hub = new RemoteHub({
    machines: () => r.machines,
    getToken: (id) => r.tokens[id] ?? null,
    sshDir: path.join(tmp, '.ssh'),
    direct: over.direct ?? null,
    spawn: (file, args) => {
      const child = new FakeChild();
      r.spawns.push({ file, args, child });
      return child;
    },
    openWs: (url, headers) => {
      const ws = new FakeWs();
      r.sockets.push({ url, headers, ws });
      return ws;
    },
    freePort: async () => ++port,
    portReady: async () => true,
    log: (e) => r.logs.push(e),
    backoffMinMs: 5,
    backoffMaxMs: 20,
    ackTimeoutMs: 150,
    silenceMs: 60_000,
  });
  for (const ev of ['session', 'removed', 'runner', 'runner_removed', 'saved', 'status']) r.hub.on(ev, (...a: unknown[]) => r.events.push(`${ev}:${a.map((x) => (typeof x === 'object' && x ? JSON.stringify(x) : String(x))).join(',')}`));
  return r;
}

const snapshot = (sessions: SessionInfo[], runners: RunnerState[] = [], extra: Record<string, unknown> = {}) => ({ type: 'snapshot', machine: 'srv', serverTime: 1, sessions, runners, cwds: ['C:\\proj'], ...extra });

describe('tunnel + token plumbing', () => {
  it('builds the ssh tunnel as an argument array, loopback on both ends, key from the machine', () => {
    const a = buildTunnelArgs({ host: '192.0.2.10', user: 'user', keyPath: '/k/pc-remote-agent' }, 41234);
    expect(a).toEqual([
      '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-i', '/k/pc-remote-agent', '-L', `127.0.0.1:41234:127.0.0.1:${AGENT_PORT}`, 'user@192.0.2.10',
    ]);
  });

  it('token env names and sources', () => {
    expect(tokenEnvName('desktop-server')).toBe('CR_AGENT_TOKEN_DESKTOP_SERVER');
    expect(tokenEnvName('m_ab12')).toBe('CR_AGENT_TOKEN_M_AB12');
    const env = { CR_AGENT_TOKEN_M1: ' abc ', CR_AGENT_TOKEN: 'plain' };
    expect(envTokenSource(env, false)('m1')).toBe('abc');
    expect(envTokenSource(env, false)('zz')).toBeNull(); // the plain fallback is dev-only
    expect(envTokenSource(env, true)('zz')).toBe('plain');
  });

  it('CR_REMOTE_DIRECT is off by default', () => {
    expect(directFromEnv({})).toBeNull();
    expect(directFromEnv({ CR_REMOTE_DIRECT: '0' })).toBeNull();
    expect(directFromEnv({ CR_REMOTE_DIRECT: '1' })).toEqual({ port: AGENT_PORT });
    expect(directFromEnv({ CR_REMOTE_DIRECT: '1', CR_REMOTE_DIRECT_PORT: '8795' })).toEqual({ port: 8795 });
  });
});

describe('RemoteHub connection', () => {
  it('spawns ssh with the key + forward, then opens a ws to the forwarded port with the token header', async () => {
    const r = rig();
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    expect(r.spawns).toHaveLength(1);
    expect(r.spawns[0].file).toBe('ssh');
    expect(r.spawns[0].args).toContain(keyFile);
    expect(r.spawns[0].args).toContain('-L');
    expect(r.spawns[0].args).toContain('user@192.0.2.10');
    expect(r.sockets[0].url).toBe('ws://127.0.0.1:40001');
    expect(r.sockets[0].headers).toEqual({ [AGENT_TOKEN_HEADER]: 'sekret-token' });
    expect(r.hub.status('m1')?.state).toBe('connecting'); // online only after the first snapshot
    r.sockets[0].ws.say(snapshot([session('a')]));
    expect(r.hub.status('m1')?.state).toBe('online');
    r.hub.stop();
  });

  it('never logs or emits the token', async () => {
    const r = rig();
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    r.sockets[0].ws.say(snapshot([session('a')]));
    r.hub.stop();
    expect(JSON.stringify(r.logs)).not.toContain('sekret-token');
    expect(r.events.join('\n')).not.toContain('sekret-token');
    expect(r.spawns[0].args.join(' ')).not.toContain('sekret-token');
  });

  it('direct mode skips ssh and connects straight to the given port', async () => {
    const r = rig({ direct: { port: 8795 }, machines: [{ ...T1, user: '', keyPath: '' }] });
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    expect(r.spawns).toHaveLength(0);
    expect(r.sockets[0].url).toBe('ws://127.0.0.1:8795');
    r.hub.stop();
  });

  it('reports a Thai error and retries when the token or the key is missing', async () => {
    const r = rig({ tokens: { m1: null } });
    r.hub.sync();
    await wait(() => r.hub.status('m1')?.state === 'error');
    expect(r.hub.status('m1')?.error).toContain('CR_AGENT_TOKEN_M1');
    expect(r.spawns).toHaveLength(0);
    r.hub.stop();

    const r2 = rig({ machines: [{ ...T1, keyPath: path.join(tmp, 'outside-key') }] });
    fs.writeFileSync(path.join(tmp, 'outside-key'), 'x');
    r2.hub.sync();
    await wait(() => r2.hub.status('m1')?.state === 'error');
    expect(r2.hub.status('m1')?.error).toBe('ไม่พบไฟล์ key ใน ~/.ssh');
    expect(r2.spawns).toHaveLength(0); // a key outside ~/.ssh never reaches ssh
    r2.hub.stop();
  });

  it('a lost socket clears that machine from the view, kills only its own tunnel and reconnects with backoff', async () => {
    const r = rig();
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    r.sockets[0].ws.say(snapshot([session('a')], [runnerState('a')]));
    r.events.length = 0;
    r.sockets[0].ws.close();
    expect(r.events).toContain('removed:m1,a');
    expect(r.events).toContain('runner_removed:m1,a');
    expect(r.spawns[0].child.killed).toBe(1);
    expect(r.hub.sessions()).toEqual([]);
    await wait(() => r.sockets.length === 2 && r.spawns.length === 2);
    expect(r.spawns[1].child).not.toBe(r.spawns[0].child);
    r.sockets[1].ws.say(snapshot([session('a')]));
    expect(r.hub.sessions().map((s) => s.sessionId)).toEqual(['a']);
    r.hub.stop();
  });

  it('an ssh child that exits is reported (with its stderr line) and restarted', async () => {
    const r = rig();
    r.hub.sync();
    await wait(() => r.spawns.length === 1);
    r.spawns[0].child.stderr!.on('data', () => {});
    (r.spawns[0].child.stderr as unknown as EventEmitter).emit('data', Buffer.from('Permission denied (publickey).\n'));
    r.spawns[0].child.emit('exit', 255);
    expect(r.hub.status('m1')).toMatchObject({ state: 'error' });
    expect(r.hub.status('m1')?.error).toContain('Permission denied');
    await wait(() => r.spawns.length === 2);
    r.hub.stop();
  });

  it('removing the machine (or turning the agent off) stops its tunnel and empties its sessions; stop() kills the rest', async () => {
    const r = rig({ machines: [{ ...T1, keyPath: keyFile }, { ...T1, id: 'm2', name: 'two', keyPath: keyFile }] });
    r.hub.sync();
    await wait(() => r.sockets.length === 2);
    r.sockets[0].ws.say(snapshot([session('a')]));
    r.sockets[1].ws.say(snapshot([session('b')]));
    r.machines = [{ ...T1, id: 'm2', name: 'two', keyPath: keyFile }]; // m1 deleted
    r.hub.sync();
    expect(r.spawns[0].child.killed).toBe(1);
    expect(r.spawns[1].child.killed).toBe(0);
    expect(r.sockets[0].ws.terminated).toBe(true);
    expect(r.hub.sessions().map((s) => s.sessionId)).toEqual(['b']);
    r.machines = [{ ...T1, id: 'm2', name: 'two', keyPath: keyFile, agent: false }];
    r.hub.sync();
    expect(r.spawns[1].child.killed).toBe(1);
    expect(r.hub.has('m2')).toBe(false);
    r.machines = [{ ...T1, keyPath: keyFile }];
    r.hub.sync();
    await wait(() => r.spawns.length === 3);
    r.hub.stop();
    expect(r.spawns[2].child.killed).toBe(1);
  });

  it('a changed host restarts the connection; an unchanged list does nothing', async () => {
    const r = rig();
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    r.hub.sync();
    expect(r.spawns).toHaveLength(1);
    r.machines = [{ ...T1, keyPath: keyFile, host: '100.1.1.1' }];
    r.hub.sync();
    expect(r.spawns[0].child.killed).toBe(1);
    await wait(() => r.spawns.length === 2);
    expect(r.spawns[1].args).toContain('user@100.1.1.1');
    r.hub.stop();
  });
});

describe('RemoteHub ingest and id re-keying', () => {
  it('stamps machineId on sessions, runners and saved; the same session id on two machines stays apart', async () => {
    const r = rig({ machines: [{ ...T1, keyPath: keyFile }, { ...T1, id: 'm2', name: 'two', keyPath: keyFile }] });
    r.hub.sync();
    await wait(() => r.sockets.length === 2);
    const saved = { sessionId: 'dup', cwd: 'c', title: 't', model: null, effort: null, source: 'web', firstSeen: 1, lastActivity: 1, hidden: false, live: false };
    r.sockets[0].ws.say(snapshot([session('dup', { title: 'one' })], [runnerState('dup')], { saved: [saved] }));
    r.sockets[1].ws.say(snapshot([session('dup', { title: 'two' })]));
    const all = r.hub.sessions();
    expect(all.map((s) => [s.machineId, s.title])).toEqual([['m1', 'one'], ['m2', 'two']]);
    expect(r.hub.runners().map((x) => x.machineId)).toEqual(['m1']);
    expect(r.hub.savedAll()).toEqual([{ ...saved, machineId: 'm1' }]);
    // removal by machine 1 leaves machine 2's session alone
    r.sockets[0].ws.say({ type: 'removed', serverTime: 2, sessionId: 'dup' });
    r.sockets[0].ws.say({ type: 'runner_removed', serverTime: 2, sessionId: 'dup' });
    expect(r.hub.sessions().map((s) => s.machineId)).toEqual(['m2']);
    expect(r.hub.machineOf('dup')).toBe('m2');
    r.hub.stop();
  });

  it('applies session / removed / runner / runner_removed / cwds frames and a snapshot diff', async () => {
    const r = rig();
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    const ws = r.sockets[0].ws;
    ws.say(snapshot([session('a'), session('b')]));
    ws.say({ type: 'session', serverTime: 2, session: session('c', { status: 'running' }) });
    ws.say({ type: 'session', serverTime: 3, session: session('a', { status: 'running' }) });
    expect(r.hub.sessions().map((s) => [s.sessionId, s.status])).toEqual([['a', 'running'], ['b', 'idle'], ['c', 'running']]);
    ws.say({ type: 'runner', serverTime: 4, runner: runnerState('c') });
    expect(r.hub.runners().map((x) => x.sessionId)).toEqual(['c']);
    ws.say({ type: 'runner_removed', serverTime: 5, sessionId: 'c' });
    expect(r.hub.runners()).toEqual([]);
    ws.say({ type: 'cwds', serverTime: 6, cwds: ['D:\\work'] });
    expect(r.hub.status('m1')?.cwds).toEqual(['D:\\work']);
    r.events.length = 0;
    ws.say(snapshot([session('b')])); // a and c are gone
    expect(r.events.filter((e) => e.startsWith('removed:')).sort()).toEqual(['removed:m1,a', 'removed:m1,c']);
    ws.emit('message', Buffer.from('not json'));
    ws.say({ type: 'session', serverTime: 1, session: { nope: true } });
    ws.say({ type: 'ping', serverTime: 9 });
    expect(r.hub.sessions().map((s) => s.sessionId)).toEqual(['b']);
    r.hub.stop();
  });
});

describe('RemoteHub forward / ack relay', () => {
  it('forwards under its own reqId without machineId and resolves with the agent ack', async () => {
    const r = rig();
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    const ws = r.sockets[0].ws;
    ws.say(snapshot([session('a')]));
    const msg = { type: 'send', reqId: 'browser-1', sessionId: 'a', text: 'hello', machineId: 'm1' } as ClientMsg;
    const p = r.hub.forward('m1', msg);
    const wire = ws.lastSent();
    expect(wire).toMatchObject({ type: 'send', sessionId: 'a', text: 'hello' });
    expect(wire.machineId).toBeUndefined();
    expect(wire.reqId).not.toBe('browser-1');
    ws.say({ type: 'ack', serverTime: 5, reqId: wire.reqId, ok: true, sessionId: 'a' });
    expect(await p).toMatchObject({ ok: true, sessionId: 'a', reqId: wire.reqId });
    r.hub.stop();
  });

  it('two in-flight commands do not mix up their acks', async () => {
    const r = rig();
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    const ws = r.sockets[0].ws;
    ws.say(snapshot([]));
    const p1 = r.hub.forward('m1', { type: 'close', reqId: 'x', sessionId: 'a' });
    const id1 = ws.lastSent().reqId;
    const p2 = r.hub.forward('m1', { type: 'close', reqId: 'x', sessionId: 'b' });
    const id2 = ws.lastSent().reqId;
    expect(id1).not.toBe(id2);
    ws.say({ type: 'ack', serverTime: 1, reqId: id2, ok: false, error: 'no b' });
    ws.say({ type: 'ack', serverTime: 1, reqId: id1, ok: true, sessionId: 'a' });
    expect(await p1).toMatchObject({ ok: true, sessionId: 'a' });
    expect(await p2).toMatchObject({ ok: false, error: 'no b' });
    r.hub.stop();
  });

  it('rejects when there is no agent or the link is not online; answers a timeout; fails pending acks on disconnect', async () => {
    const r = rig();
    await expect(r.hub.forward('nope', { type: 'stop', reqId: 'x', sessionId: 'a' })).rejects.toThrow('ไม่ได้เปิด');
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    await expect(r.hub.forward('m1', { type: 'stop', reqId: 'x', sessionId: 'a' })).rejects.toThrow('ยังไม่เชื่อมต่อ'); // no snapshot yet
    const ws = r.sockets[0].ws;
    ws.say(snapshot([]));
    const slow = await r.hub.forward('m1', { type: 'stop', reqId: 'x', sessionId: 'a' }); // nobody answers
    expect(slow).toMatchObject({ ok: false, error: 'เครื่องปลายทางไม่ตอบ' });
    const pending = r.hub.forward('m1', { type: 'stop', reqId: 'x', sessionId: 'a' });
    ws.close();
    expect(await pending).toMatchObject({ ok: false, error: 'ขาดการเชื่อมต่อกับเครื่องปลายทาง' });
    r.hub.stop();
  });
});

// ---------- main server routing (real startServer + a fake hub) ----------

describe('command routing in the main server', () => {
  let server: RunningServer;
  let watcher: Watcher;
  let hub: RemoteHub;
  const forwarded: { machineId: string; msg: ClientMsg }[] = [];
  let ws: WebSocket;
  const msgs: ServerMsg[] = [];

  beforeEach(async () => {
    forwarded.length = 0;
    msgs.length = 0;
    const claude = path.join(tmp, 'claude');
    fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
    watcher = new Watcher({ claudeDir: claude, pollMs: 50 });
    const r = rig();
    hub = r.hub;
    // the agent end of the hub is a fake socket; forward() is observed through it
    r.hub.sync();
    await wait(() => r.sockets.length === 1);
    const agent = r.sockets[0].ws;
    agent.say(snapshot([session('rs1')], [runnerState('rs1')]));
    const realForward = hub.forward.bind(hub);
    hub.forward = (machineId, msg) => {
      forwarded.push({ machineId, msg });
      const p = realForward(machineId, msg);
      if (!hub.has(machineId)) return p; // refused without sending anything
      const wire = agent.lastSent();
      queueMicrotask(() => agent.say({ type: 'ack', serverTime: 1, reqId: wire.reqId, ok: true, sessionId: msg.type === 'start' ? 'new-remote' : (msg as { sessionId?: string }).sessionId }));
      return p;
    };
    server = await startServer({ watcher, port: 0, runner: new Runner({ allowedCwds: () => [] }), remote: hub, log: () => {} });
    ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    await new Promise<void>((res) => ws.on('open', () => res()));
    await wait(() => msgs.some((m) => m.type === 'snapshot'));
  });
  afterEach(async () => {
    ws.close();
    hub.stop();
    await server.close();
    watcher.stop();
  });

  it('the snapshot carries the remote sessions and runners, stamped with their machine', () => {
    const snap = msgs.find((m) => m.type === 'snapshot') as Extract<ServerMsg, { type: 'snapshot' }>;
    expect(snap.sessions.map((s) => [s.sessionId, s.machineId])).toEqual([['rs1', 'm1']]);
    expect(snap.runners?.map((x) => [x.sessionId, x.machineId])).toEqual([['rs1', 'm1']]);
  });

  it('a send with machineId is forwarded to that agent and the ack comes back under the browser reqId', async () => {
    ws.send(JSON.stringify({ type: 'send', reqId: 'b1', machineId: 'm1', sessionId: 'rs1', text: 'hi' }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 'b1'));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ machineId: 'm1', msg: { type: 'send', sessionId: 'rs1', text: 'hi' } });
    expect((forwarded[0].msg as { machineId?: string }).machineId).toBeUndefined();
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 'b1')).toMatchObject({ ok: true, sessionId: 'rs1' });
  });

  it('start / answer / close / adopt / saved_resume all route; the new session id from the agent reaches the browser', async () => {
    ws.send(JSON.stringify({ type: 'start', reqId: 'b2', machineId: 'm1', cwd: 'C:\\proj', model: 'haiku', effort: 'low', prompt: 'tiny' }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 'b2'));
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 'b2')).toMatchObject({ ok: true, sessionId: 'new-remote' });
    for (const [i, body] of [
      { type: 'answer', sessionId: 'rs1', requestId: 'q1', behavior: 'allow' },
      { type: 'close', sessionId: 'rs1' },
      { type: 'adopt', sessionId: 'rs1' },
      { type: 'saved_resume', sessionId: 'rs1' },
    ].entries()) {
      ws.send(JSON.stringify({ ...body, reqId: `c${i}`, machineId: 'm1' }));
      await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === `c${i}`));
    }
    expect(forwarded.map((f) => f.msg.type)).toEqual(['start', 'answer', 'close', 'adopt', 'saved_resume']);
  });

  it('takeover with a machineId is forwarded to that agent (machineId dropped), not run on this PC', async () => {
    const sid = '123e4567-e89b-42d3-a456-426614174000';
    ws.send(JSON.stringify({ type: 'takeover', reqId: 't1', machineId: 'm1', sessionId: sid }));
    await wait(() => msgs.some((m) => m.type === 'ack' && m.reqId === 't1'));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ machineId: 'm1', msg: { type: 'takeover', sessionId: sid } });
    expect((forwarded[0].msg as { machineId?: string }).machineId).toBeUndefined();
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 't1')).toMatchObject({ ok: true, sessionId: sid });
    expect(routeTarget({ type: 'takeover', machineId: 'm1' })).toBe('m1');
    expect(parseClientMsg({ type: 'takeover', reqId: 'r', sessionId: 'rs1' })).toMatchObject({ ok: false }); // strict uuid
  });

  it('an invalid command is refused here, never forwarded; an unknown or agent-less machine gets an error ack', async () => {
    ws.send(JSON.stringify({ type: 'send', reqId: 'e1', machineId: 'm1', sessionId: 'rs1', text: '   ' }));
    ws.send(JSON.stringify({ type: 'send', reqId: 'e2', machineId: '../x', sessionId: 'rs1', text: 'hi' }));
    ws.send(JSON.stringify({ type: 'stop', reqId: 'e3', machineId: 'ghost', sessionId: 'rs1' }));
    await wait(() => ['e1', 'e2', 'e3'].every((id) => msgs.some((m) => m.type === 'ack' && m.reqId === id)));
    for (const id of ['e1', 'e2', 'e3']) expect(msgs.find((m) => m.type === 'ack' && m.reqId === id)).toMatchObject({ ok: false });
    expect(forwarded.map((f) => f.machineId)).toEqual(['ghost']); // only the well-formed one reached the hub, which refused it
    expect(msgs.find((m) => m.type === 'ack' && m.reqId === 'e3')).toMatchObject({ error: expect.stringContaining('ไม่ได้เปิด') });
  });

  it('remote removals are broadcast with their machineId', async () => {
    const r = (hub as unknown as { conns: Map<string, { ws: FakeWs }> }).conns.get('m1')!;
    r.ws.say({ type: 'removed', serverTime: 3, sessionId: 'rs1' });
    await wait(() => msgs.some((m) => m.type === 'removed'));
    expect(msgs.find((m) => m.type === 'removed')).toMatchObject({ sessionId: 'rs1', machineId: 'm1' });
  });
});

describe('routeTarget and machine commands', () => {
  it('only routable types with a machineId are routed', () => {
    expect(routeTarget({ type: 'send', machineId: 'm1' })).toBe('m1');
    expect(routeTarget({ type: 'send' })).toBeNull();
    expect(routeTarget({ type: 'send', machineId: null })).toBeNull();
    expect(routeTarget({ type: 'send', machineId: '../x' })).toBe('');
    expect(routeTarget({ type: 'send', machineId: 5 })).toBe('');
    expect(routeTarget({ type: 'machine_delete', machineId: 'm1' })).toBeNull(); // machine_* keep their own meaning
    expect(routeTarget({ type: 'machine_attach', machineId: 'm1' })).toBeNull();
    expect(routeTarget('x')).toBeNull();
  });

  it('machine_add carries the agent flag and rejects a non-boolean', () => {
    const base = { type: 'machine_add', reqId: 'r', name: 'n', host: '1.2.3.4', user: 'u', keyPath: '', shell: 'cmd' };
    expect(parseClientMsg({ ...base, agent: true })).toMatchObject({ ok: true, msg: { agent: true } });
    expect(parseClientMsg(base)).toMatchObject({ ok: true });
    expect((parseClientMsg(base) as { msg: object }).msg).not.toHaveProperty('agent');
    expect(parseClientMsg({ ...base, agent: 'yes' })).toMatchObject({ ok: false });
  });

  it('the agent flag is stored, kept when an older form leaves it out, and shown with the agent status', () => {
    const db = new WorklogDb(':memory:');
    let n = 0;
    const svc = new MachineService({ db, sshDir: path.join(tmp, '.ssh'), newId: () => `mm${++n}` });
    const fields = { name: 'pc', host: '1.2.3.4', user: 'u', keyPath: keyFile, shell: 'cmd' as const };
    const id = svc.add({ ...fields, agent: true });
    expect(db.getMachine(id)?.agent).toBe(true);
    expect(svc.list().find((m) => m.id === id)).toMatchObject({ agent: true, agentState: 'connecting' });
    svc.setAgentStatus(id, { state: 'online', cwds: ['C:\\p'] });
    expect(svc.list().find((m) => m.id === id)).toMatchObject({ agentState: 'online', agentCwds: ['C:\\p'] });
    svc.setAgentStatus(id, { state: 'error', error: 'SSH หลุด' });
    expect(svc.list().find((m) => m.id === id)).toMatchObject({ agentState: 'error', agentError: 'SSH หลุด' });
    svc.update(id, { ...fields, name: 'pc2' }); // no agent field: keeps true
    expect(db.getMachine(id)?.agent).toBe(true);
    svc.update(id, { ...fields, agent: false });
    expect(db.getMachine(id)?.agent).toBe(false);
    expect(svc.list().find((m) => m.id === id)).not.toHaveProperty('agent');
  });
});

// ---------- agent mode ----------

describe('agent mode', () => {
  it('refuses to bind anything but loopback', async () => {
    for (const h of ['0.0.0.0', '::', '', '192.0.2.10', '192.168.1.5', 'example.com']) expect(() => assertLoopbackHost(h), h).toThrow('loopback');
    for (const h of ['127.0.0.1', 'localhost', '::1']) expect(() => assertLoopbackHost(h)).not.toThrow();
    const watcher = new Watcher({ claudeDir: path.join(tmp, 'c'), pollMs: 50 });
    await expect(startServer({ watcher, port: 0, host: '0.0.0.0', log: () => {} })).rejects.toThrow('loopback');
    await expect(startServer({ watcher, port: 0, host: '192.0.2.10', log: () => {} })).rejects.toThrow('loopback');
    watcher.stop();
  });

  it('mode switches and port', () => {
    expect(isAgentMode({ CR_MODE: 'agent' }, [])).toBe(true);
    expect(isAgentMode({}, ['node', 'x', '--agent'])).toBe(true);
    expect(isAgentMode({}, ['--serve-web'])).toBe(false);
    expect(agentPortFromEnv({})).toBe(AGENT_PORT);
    expect(agentPortFromEnv({ CR_AGENT_PORT: '8795' })).toBe(8795);
    expect(agentPortFromEnv({ CR_AGENT_PORT: 'x' })).toBe(AGENT_PORT);
  });

  it('token hash: env hash, env plain (dev), file, nothing = null; compare is exact', () => {
    const file = path.join(tmp, 'agent-token.sha256');
    expect(loadTokenHash({}, file)).toBeNull();
    fs.writeFileSync(file, `${sha256Hex('from-file')}\r\n`);
    expect(loadTokenHash({}, file)).toBe(sha256Hex('from-file'));
    expect(loadTokenHash({ CR_AGENT_TOKEN: 'plain' }, file)).toBe(sha256Hex('plain'));
    expect(loadTokenHash({ CR_AGENT_TOKEN_SHA256: sha256Hex('h').toUpperCase(), CR_AGENT_TOKEN: 'plain' }, file)).toBe(sha256Hex('h'));
    fs.writeFileSync(file, 'garbage');
    expect(loadTokenHash({}, file)).toBeNull();
    const h = sha256Hex('right');
    expect(tokenMatches(h, 'right')).toBe(true);
    expect(tokenMatches(h, 'wrong')).toBe(false);
    expect(tokenMatches(h, '')).toBe(false);
    expect(tokenMatches(h, undefined)).toBe(false);
    expect(headerTokenOk(h, 'right')).toBe(true);
    expect(headerTokenOk(h, ['right'])).toBe(false);
  });

  describe('server with the agent feature set', () => {
    let server: RunningServer;
    let watcher: Watcher;
    const hash = sha256Hex('agent-secret');
    beforeEach(async () => {
      const claude = path.join(tmp, 'claude2');
      fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
      watcher = new Watcher({ claudeDir: claude, pollMs: 50 });
      server = await startServer({ watcher, port: 0, host: '127.0.0.1', runner: new Runner({ allowedCwds: () => [] }), verifyToken: (h) => headerTokenOk(hash, h), log: () => {} });
    });
    afterEach(async () => {
      await server.close();
      watcher.stop();
    });
    const connect = (headers?: Record<string, string>) =>
      new Promise<{ ws: WebSocket; msgs: ServerMsg[] } | { error: string }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers });
        const msgs: ServerMsg[] = [];
        ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
        ws.on('open', () => resolve({ ws, msgs }));
        ws.on('error', (e) => resolve({ error: e.message }));
      });

    it('refuses a socket without the token, or with a wrong one; accepts the right one', async () => {
      const none = await connect();
      expect(none).toMatchObject({ error: expect.stringContaining('401') });
      const bad = await connect({ [AGENT_TOKEN_HEADER]: 'nope' });
      expect(bad).toMatchObject({ error: expect.stringContaining('401') });
      const ok = await connect({ [AGENT_TOKEN_HEADER]: 'agent-secret' });
      expect('ws' in ok).toBe(true);
      if ('ws' in ok) {
        await wait(() => ok.msgs.some((m) => m.type === 'snapshot'));
        ok.ws.close();
      }
    });

    it('the web-only features are not there: clips, links, machines, summary assistant all answer an error', async () => {
      const c = await connect({ [AGENT_TOKEN_HEADER]: 'agent-secret' });
      if (!('ws' in c)) throw new Error(c.error);
      const sends: Record<string, unknown>[] = [
        { type: 'clip_start', reqId: 'g1', topic: 't', points: '', settings: { length: '30s', ratio: '16:9', lang: 'th', voice: false, music: false, cast: [] }, styleId: 'ours:a', voiceId: null, scriptModel: 'haiku', builderModel: 'sonnet', effort: 'low' },
        { type: 'link_create', reqId: 'g2', from: 'a', to: 'b' },
        { type: 'machine_add', reqId: 'g3', name: 'n', host: '1.2.3.4', user: 'u', keyPath: '', shell: 'cmd' },
        { type: 'ask', reqId: 'g4', question: 'hello?' },
        { type: 'saved_hide', reqId: 'g5', sessionId: 'a' },
      ];
      for (const s of sends) c.ws.send(JSON.stringify(s));
      await wait(() => ['g1', 'g2', 'g3', 'g4', 'g5'].every((id) => c.msgs.some((m) => m.type === 'ack' && m.reqId === id)));
      for (const id of ['g1', 'g2', 'g3', 'g4', 'g5']) expect(c.msgs.find((m) => m.type === 'ack' && m.reqId === id), id).toMatchObject({ ok: false });
      const snap = c.msgs.find((m) => m.type === 'snapshot') as Extract<ServerMsg, { type: 'snapshot' }>;
      expect(snap.machines).toBeUndefined();
      expect(snap.links).toBeUndefined();
      expect(c.msgs.some((m) => m.type === 'clips' || m.type === 'worklog' || m.type === 'machines')).toBe(false);
      c.ws.close();
    });

    it('serves /health only: no static web, no api routes', async () => {
      const ok = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(ok.status).toBe(200);
      for (const p of ['/', '/index.html', '/api/gallery/list', '/api/agents/a/b/timeline', '/api/voices']) expect((await fetch(`http://127.0.0.1:${server.port}${p}`)).status, p).toBe(404);
    });
  });
});

describe('parseAgentToken', () => {
  it('takes the first url-safe line of 32+ chars and ignores noise', async () => {
    const { parseAgentToken } = await import('../src/remote');
    const tok = 'a'.repeat(20) + 'B_-' + '9'.repeat(20);
    expect(parseAgentToken(`warning: something\r\n${tok}\r\n`)).toBe(tok);
    expect(parseAgentToken('short\n')).toBeNull();
    expect(parseAgentToken('has space ' + 'x'.repeat(40))).toBeNull();
  });
});
