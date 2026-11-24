import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LinkInfo, ServerMsg } from '../../shared/protocol';
import { parseClientMsg } from '../src/commands';
import { startServer, type RunningServer } from '../src/index';
import { createState, ingestLine } from '../src/parser';
import { RELAY_GLOBAL_MAX, RELAY_TEXT_MAX, Relay, wrapForward } from '../src/relay';
import { Runner, RunnerSession, type ChildLike, type TurnEnd } from '../src/runner';
import { Watcher } from '../src/watcher';

// ---------- Relay unit tests (fakes) ----------

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const C = 'cccccccc-1111-2222-3333-444444444444';

function mk(opts: { live?: string[]; known?: string[]; titles?: Record<string, string> } = {}) {
  const live = new Set(opts.live ?? [B, C]);
  const known = new Set([...(opts.known ?? [A]), ...live]);
  const sent: { to: string; text: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  let t = 1_000_000;
  let n = 0;
  const relay = new Relay({
    send: (to, text) => {
      if (!live.has(to)) throw new Error('process has ended');
      sent.push({ to, text });
    },
    isLiveRunner: (id) => live.has(id),
    exists: (id) => known.has(id),
    titleOf: (id) => opts.titles?.[id],
    now: () => t,
    newId: () => `link${++n}`,
    log: (e) => logs.push(e),
  });
  const changes: LinkInfo[][] = [];
  relay.on('change', (l: LinkInfo[]) => changes.push(l));
  return { relay, sent, logs, changes, live, advance: (ms: number) => (t += ms), clock: () => t };
}

describe('Relay', () => {
  it('forwards a final answer with the exact wrapper', () => {
    const { relay, sent } = mk({ titles: { [A]: 'งานหลัก' } });
    const id = relay.create(A, B);
    relay.onSourceTurnEnd(A, 'คำตอบสุดท้าย');
    expect(sent).toEqual([{ to: B, text: `[ข้อความจาก งานหลัก · aaaaaaaa]\nคำตอบสุดท้าย` }]);
    expect(sent[0].text).toBe(wrapForward('งานหลัก', A, 'คำตอบสุดท้าย'));
    expect(relay.list()[0]).toMatchObject({ id, from: A, to: B, paused: false, state: 'ok', forwards: 1, maxForwards: 6, lastForwardAt: 1_000_000 });
  });

  it('falls back to the session id when there is no title', () => {
    const { relay, sent } = mk();
    relay.create(A, B);
    relay.onSourceTurnEnd(A, 'x');
    expect(sent[0].text.startsWith(`[ข้อความจาก ${A} · aaaaaaaa]\n`)).toBe(true);
  });

  it('refuses a target that is not a live Runner job', () => {
    const { relay } = mk({ live: [B], known: [A, C] });
    expect(() => relay.create(B, C)).toThrow('ปลายทางต้องเป็นงานที่คุมจากเว็บ');
    expect(() => relay.create(A, 'unknown-id')).toThrow('ปลายทางต้องเป็นงานที่คุมจากเว็บ');
    expect(relay.list()).toEqual([]);
  });

  it('refuses an unknown source, A = B and a duplicate pair', () => {
    const { relay } = mk();
    expect(() => relay.create('ghost', B)).toThrow('ไม่พบงานต้นทาง');
    expect(() => relay.create(B, B)).toThrow('คนละงาน');
    relay.create(A, B);
    expect(() => relay.create(A, B)).toThrow('มีลิงก์นี้อยู่แล้ว');
    relay.create(B, C); // a different pair, and the reverse pair, are fine
    relay.create(C, B);
    expect(relay.list()).toHaveLength(3);
  });

  it('goes to limit at maxForwards and stops; resume resets the counter', () => {
    const { relay, sent } = mk();
    const id = relay.create(A, B, 2);
    relay.onSourceTurnEnd(A, 'one');
    relay.onSourceTurnEnd(A, 'two');
    expect(relay.list()[0]).toMatchObject({ forwards: 2, state: 'limit' });
    relay.onSourceTurnEnd(A, 'three');
    expect(sent).toHaveLength(2);
    relay.resume(id);
    expect(relay.list()[0]).toMatchObject({ forwards: 0, state: 'ok' });
    relay.onSourceTurnEnd(A, 'four');
    expect(sent).toHaveLength(3);
  });

  it('a user message to either end resets the counters of links touching that session', () => {
    const { relay, sent } = mk();
    relay.create(A, B, 2);
    relay.create(C, B, 3);
    relay.create(B, C, 3);
    relay.onSourceTurnEnd(A, 'x');
    relay.onSourceTurnEnd(A, 'y');
    relay.onSourceTurnEnd(C, 'z');
    expect(relay.list().map((l) => [l.forwards, l.state])).toEqual([[2, 'limit'], [1, 'ok'], [0, 'ok']]);
    relay.onUserSend(A);
    expect(relay.list().map((l) => [l.forwards, l.state])).toEqual([[0, 'ok'], [1, 'ok'], [0, 'ok']]);
    relay.onSourceTurnEnd(A, 'again');
    expect(sent).toHaveLength(4);
    relay.onUserSend(B); // B is the target of A->B and C->B and the source of B->C
    expect(relay.list().map((l) => l.forwards)).toEqual([0, 0, 0]);
  });

  it('a relayed message does not reset counters (only onUserSend does)', () => {
    const { relay } = mk({ live: [A, B], known: [A, B] });
    relay.create(A, B, 3);
    relay.create(B, A, 3);
    relay.onSourceTurnEnd(A, 'ping');
    relay.onSourceTurnEnd(B, 'pong');
    relay.onSourceTurnEnd(A, 'ping2');
    expect(relay.list().map((l) => l.forwards)).toEqual([2, 1]);
  });

  it('a paused link does not forward and does not count; unpausing continues', () => {
    const { relay, sent } = mk();
    const id = relay.create(A, B);
    relay.pause(id, true);
    relay.onSourceTurnEnd(A, 'x');
    expect(sent).toHaveLength(0);
    expect(relay.list()[0]).toMatchObject({ paused: true, forwards: 0 });
    relay.pause(id, false);
    relay.onSourceTurnEnd(A, 'y');
    expect(sent).toHaveLength(1);
  });

  it('global cap: the 31st forward within 10 minutes pauses links with state rate; the window slides', () => {
    const { relay, sent, advance } = mk();
    const id = relay.create(A, B, 50);
    const other = relay.create(A, C, 50);
    // 15 turns x 2 links = 30 forwards
    for (let i = 0; i < RELAY_GLOBAL_MAX / 2; i++) relay.onSourceTurnEnd(A, `m${i}`);
    expect(sent).toHaveLength(RELAY_GLOBAL_MAX);
    relay.onSourceTurnEnd(A, 'over');
    expect(sent).toHaveLength(RELAY_GLOBAL_MAX);
    expect(relay.list().map((l) => l.state)).toEqual(['rate', 'rate']);
    relay.resume(id);
    relay.resume(other);
    relay.onSourceTurnEnd(A, 'still capped');
    expect(sent).toHaveLength(RELAY_GLOBAL_MAX);
    expect(relay.list().map((l) => l.state)).toEqual(['rate', 'rate']);
    relay.resume(id);
    advance(10 * 60 * 1000 + 1);
    relay.onSourceTurnEnd(A, 'later');
    expect(sent).toHaveLength(RELAY_GLOBAL_MAX + 1);
  });

  it('skips empty, error and interrupted turns', () => {
    const { relay, sent } = mk();
    relay.create(A, B);
    relay.onSourceTurnEnd(A, '');
    relay.onSourceTurnEnd(A, '  \n ');
    relay.onSourceTurnEnd(A, 'API Error: 529', { isError: true });
    relay.onSourceTurnEnd(A, 'partial', { interrupted: true });
    expect(sent).toHaveLength(0);
    expect(relay.list()[0].forwards).toBe(0);
  });

  it('ignores terminal answers that are not newer than the link', () => {
    const { relay, sent, clock } = mk();
    relay.create(A, B);
    relay.onSourceTurnEnd(A, 'old', { ts: clock() - 5 });
    relay.onSourceTurnEnd(A, 'same', { ts: clock() });
    expect(sent).toHaveLength(0);
    relay.onSourceTurnEnd(A, 'new', { ts: clock() + 1 });
    expect(sent).toHaveLength(1);
  });

  it('removes links when either end is gone and broadcasts the change', () => {
    const { relay, changes } = mk();
    relay.create(A, B);
    relay.create(B, C);
    relay.create(C, B);
    changes.length = 0;
    relay.onSessionGone(B);
    expect(relay.list()).toEqual([]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual([]);
    relay.onSessionGone('nobody');
    expect(changes).toHaveLength(1); // nothing changed, nothing broadcast
    relay.create(A, C);
    relay.onSessionGone(A);
    expect(relay.list()).toEqual([]);
  });

  it('strips secrets and caps the answer at 8000 chars', () => {
    const { relay, sent } = mk();
    relay.create(A, B);
    relay.onSourceTurnEnd(A, 'key sk-ant-abcdefghijklmnopqrstuvwxyz0123 end');
    expect(sent[0].text).toContain('[secret]');
    expect(sent[0].text).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
    relay.onSourceTurnEnd(A, 'x'.repeat(20_000));
    const body = sent[1].text.split('\n').slice(1).join('\n');
    expect(body.length).toBe(RELAY_TEXT_MAX);
  });

  it('a failed send (target died) puts the link in error without counting; resume clears it', () => {
    const { relay, sent, live, logs } = mk();
    const id = relay.create(A, B);
    live.delete(B);
    relay.onSourceTurnEnd(A, 'x');
    expect(relay.list()[0]).toMatchObject({ state: 'error', forwards: 0 });
    expect(relay.list()[0].error).toBeTruthy();
    expect(sent).toHaveLength(0);
    live.add(B);
    relay.onSourceTurnEnd(A, 'y'); // an errored link stays stopped
    expect(sent).toHaveLength(0);
    relay.resume(id);
    expect(relay.list()[0].error).toBeUndefined();
    relay.onSourceTurnEnd(A, 'z');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('"z"');
  });

  it('logs ids and lengths only, never text', () => {
    const { relay, logs } = mk();
    relay.create(A, B);
    relay.onSourceTurnEnd(A, 'TOP-SECRET-ANSWER-TEXT');
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('TOP-SECRET');
    expect(logs[0]).toMatchObject({ cmd: 'link_forward', ok: true, from: A, to: B });
    expect(typeof logs[0].chars).toBe('number');
  });

  it('unknown link ids are refused', () => {
    const { relay } = mk();
    expect(() => relay.delete('nope')).toThrow();
    expect(() => relay.pause('nope', true)).toThrow();
    expect(() => relay.resume('nope')).toThrow();
  });
});

// ---------- command parsing ----------

describe('link commands parsing', () => {
  it('link_create', () => {
    expect(parseClientMsg({ type: 'link_create', reqId: 'r1', from: A, to: B })).toEqual({ ok: true, msg: { type: 'link_create', reqId: 'r1', from: A, to: B } });
    expect(parseClientMsg({ type: 'link_create', reqId: 'r1', from: A, to: B, maxForwards: 50 })).toMatchObject({ ok: true, msg: { maxForwards: 50 } });
    for (const bad of [0, 51, 1.5, '3', null, -1]) {
      expect(parseClientMsg({ type: 'link_create', reqId: 'r1', from: A, to: B, maxForwards: bad as unknown as number }).ok).toBe(false);
    }
    expect(parseClientMsg({ type: 'link_create', reqId: 'r1', from: 'bad id!', to: B }).ok).toBe(false);
    expect(parseClientMsg({ type: 'link_create', reqId: 'r1', from: A }).ok).toBe(false);
    expect(parseClientMsg({ type: 'link_create', reqId: 'r1', from: A, to: '../x' }).ok).toBe(false);
  });
  it('link_delete / link_resume / link_pause', () => {
    expect(parseClientMsg({ type: 'link_delete', reqId: 'r', linkId: 'l1' })).toEqual({ ok: true, msg: { type: 'link_delete', reqId: 'r', linkId: 'l1' } });
    expect(parseClientMsg({ type: 'link_resume', reqId: 'r', linkId: 'l1' })).toEqual({ ok: true, msg: { type: 'link_resume', reqId: 'r', linkId: 'l1' } });
    expect(parseClientMsg({ type: 'link_pause', reqId: 'r', linkId: 'l1', paused: true })).toEqual({ ok: true, msg: { type: 'link_pause', reqId: 'r', linkId: 'l1', paused: true } });
    expect(parseClientMsg({ type: 'link_pause', reqId: 'r', linkId: 'l1' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'link_pause', reqId: 'r', linkId: 'l1', paused: 'yes' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'link_delete', reqId: 'r' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'link_resume', reqId: 'r', linkId: 'a b' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'link_delete', linkId: 'l1' }).ok).toBe(false);
  });
});

// ---------- parser: end-of-turn tracking for terminal sources ----------

describe('parser endTurnSeq', () => {
  const asst = (content: unknown[], extra: Record<string, unknown> = {}, stop: string | null = 'end_turn') =>
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-24T10:00:00.000Z', message: { model: 'claude-opus-5-5', stop_reason: stop, content }, ...extra });

  it('counts only end_turn entries with real text and keeps the full text', () => {
    const st = createState();
    const long = 'y'.repeat(3000);
    ingestLine(st, asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], {}, 'tool_use'));
    ingestLine(st, asst([{ type: 'text', text: 'mid text' }], {}, 'tool_use'));
    expect(st.endTurnSeq).toBe(0);
    ingestLine(st, asst([{ type: 'text', text: long }]));
    expect(st.endTurnSeq).toBe(1);
    expect(st.lastEndTurn?.text).toBe(long);
    expect(st.lastTextFull.length).toBeLessThan(long.length); // the clipped copy is untouched
    ingestLine(st, asst([{ type: 'thinking', thinking: 'hm' }]));
    expect(st.endTurnSeq).toBe(1); // no text
    ingestLine(st, asst([{ type: 'text', text: 'API Error: 500' }], { isApiErrorMessage: true, uuid: 'u1' }));
    expect(st.endTurnSeq).toBe(1); // api error
    ingestLine(st, asst([{ type: 'text', text: 'second' }]));
    expect(st.endTurnSeq).toBe(2);
    expect(st.lastEndTurn?.text).toBe('second');
  });
});

// ---------- Runner turn_end event ----------

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 5151;
  written: Record<string, any>[] = [];
  private buf = '';
  constructor() {
    super();
    this.stdin.on('end', () => queueMicrotask(() => this.emit('exit', 0, null)));
    this.stdin.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.written.push(JSON.parse(this.buf.slice(0, i)));
        this.buf = this.buf.slice(i + 1);
      }
    });
  }
  kill(): boolean {
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
  emitLine(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }
  userTexts(): string[] {
    return this.written.filter((w) => w.type === 'user').map((w) => w.message.content as string);
  }
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until timed out');
    await tick(5);
  }
}

const assistantEv = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  ...extra,
});

describe('RunnerSession turn_end', () => {
  function mkSession() {
    const child = new FakeChild();
    const session = new RunnerSession({ sessionId: 'sess-1', cwd: 'C:\\x', child, model: 'haiku', effort: 'high' });
    const ends: TurnEnd[] = [];
    session.on('turn_end', (e: TurnEnd) => ends.push(e));
    return { child, session, ends };
  }

  it('emits the result text (falls back to the last assistant text); main thread only', async () => {
    const { child, session, ends } = mkSession();
    session.sendUser('go');
    child.emitLine(assistantEv('from a subagent', { parent_tool_use_id: 'toolu_1' }));
    child.emitLine(assistantEv('final from stream'));
    child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: '' });
    await until(() => ends.length === 1);
    expect(ends[0]).toEqual({ sessionId: 'sess-1', text: 'final from stream', isError: false, interrupted: false });
    session.sendUser('again');
    child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'result text wins' });
    await until(() => ends.length === 2);
    expect(ends[1].text).toBe('result text wins');
  });

  it('flags errors and interrupts', async () => {
    const { child, session, ends } = mkSession();
    session.sendUser('go');
    child.emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });
    await until(() => ends.length === 1);
    expect(ends[0].isError).toBe(true);
    session.sendUser('again');
    session.stop();
    child.emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'cut short' });
    await until(() => ends.length === 2);
    expect(ends[1].interrupted).toBe(true);
  });
});

// ---------- Watcher turn_end (terminal source) ----------

describe('Watcher turn_end', () => {
  let tmp: string;
  let watcher: Watcher | null = null;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-wt-'));
    fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'projects', 'proj'), { recursive: true });
  });
  afterEach(() => {
    watcher?.stop();
    watcher = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('does not replay history, reports each new end_turn answer once', async () => {
    const sid = 'term-sess-0001';
    fs.writeFileSync(
      path.join(tmp, 'sessions', '1111.json'),
      JSON.stringify({ pid: 1111, sessionId: sid, cwd: 'C:\\proj', startedAt: Date.now(), kind: 'interactive', name: 'n' }),
    );
    const file = path.join(tmp, 'projects', 'proj', `${sid}.jsonl`);
    const line = (text: string, ts: string) =>
      `${JSON.stringify({ type: 'assistant', timestamp: ts, message: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })}\n`;
    fs.writeFileSync(file, line('history answer', '2026-11-24T09:00:00.000Z'));
    watcher = new Watcher({ claudeDir: tmp, pollMs: 30, isPidAlive: (p) => p === 1111 });
    const ends: { sessionId: string; text: string; ts: number }[] = [];
    watcher.on('turn_end', (e) => ends.push(e));
    watcher.start();
    await until(() => watcher!.snapshot().some((s) => s.sessionId === sid));
    await tick(120);
    expect(ends).toHaveLength(0);
    fs.appendFileSync(file, line('fresh answer', '2026-11-24T10:00:00.000Z'));
    await until(() => ends.length === 1);
    await tick(120);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ sessionId: sid, text: 'fresh answer', ts: Date.parse('2026-11-24T10:00:00.000Z') });
  });
});

// ---------- WebSocket: link_create / broadcast / forwarding ----------

describe('links over the WebSocket', () => {
  let tmp: string;
  let server: RunningServer | null = null;
  let watcher: Watcher | null = null;
  const children: FakeChild[] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-link-'));
    fs.mkdirSync(path.join(tmp, 'claude', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'claude', 'projects'), { recursive: true });
    children.length = 0;
  });
  afterEach(async () => {
    watcher?.stop();
    await server?.close();
    watcher = null;
    server = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function boot(withRelay = true) {
    const work = path.join(tmp, 'work');
    fs.mkdirSync(work);
    watcher = new Watcher({ claudeDir: path.join(tmp, 'claude'), pollMs: 50, isPidAlive: () => false });
    const runner = new Runner({
      allowedCwds: () => [work],
      spawn: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
    });
    const relay = new Relay({
      send: (to, text) => runner.send(to, text),
      isLiveRunner: (id) => runner.isAlive(id),
      exists: (id) => runner.has(id),
      titleOf: () => 'Alpha',
    });
    server = await startServer({ watcher, port: 0, pingMs: 100000, runner, relay: withRelay ? relay : undefined, allowedCwds: () => [work] });
    return { work, runner };
  }

  function connect(): Promise<{ ws: WebSocket; msgs: ServerMsg[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}`);
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
  const lastLinks = (msgs: ServerMsg[]): LinkInfo[] | undefined => {
    const l = msgs.filter((m): m is Extract<ServerMsg, { type: 'links' }> => m.type === 'links').pop();
    return l?.links;
  };

  it('link_create acks with linkId, a links broadcast follows, a final answer is forwarded, user send resets, close removes the link', async () => {
    const { work } = await boot();
    const { ws, msgs } = await connect();
    await until(() => msgs.some((m) => m.type === 'snapshot'));
    expect((msgs.find((m) => m.type === 'snapshot') as Extract<ServerMsg, { type: 'snapshot' }>).links).toEqual([]);

    const start = async (reqId: string) => {
      ws.send(JSON.stringify({ type: 'start', reqId, cwd: work, model: 'haiku', effort: 'low', prompt: `p-${reqId}` }));
      const a = await ackFor(msgs, reqId);
      expect(a.ok).toBe(true);
      return a.sessionId!;
    };
    const a = await start('sa');
    const b = await start('sb');

    // refused: target a terminal / unknown session, A = B
    ws.send(JSON.stringify({ type: 'link_create', reqId: 'x1', from: a, to: 'terminal-only-session' }));
    const x1 = await ackFor(msgs, 'x1');
    expect(x1.ok).toBe(false);
    expect(x1.error).toBe('ปลายทางต้องเป็นงานที่คุมจากเว็บ');
    ws.send(JSON.stringify({ type: 'link_create', reqId: 'x2', from: a, to: a }));
    expect((await ackFor(msgs, 'x2')).ok).toBe(false);

    ws.send(JSON.stringify({ type: 'link_create', reqId: 'l1', from: a, to: b, maxForwards: 2 }));
    const ack = await ackFor(msgs, 'l1');
    expect(ack.ok).toBe(true);
    expect(typeof ack.linkId).toBe('string');
    await until(() => (lastLinks(msgs) ?? []).some((l) => l.id === ack.linkId));
    expect(lastLinks(msgs)![0]).toMatchObject({ from: a, to: b, paused: false, state: 'ok', forwards: 0, maxForwards: 2 });

    // A finishes a turn -> B gets the wrapped answer
    children[0].emitLine(assistantEv('hello from A'));
    children[0].emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'hello from A' });
    await until(() => children[1].userTexts().length === 2);
    expect(children[1].userTexts()[1]).toBe(`[ข้อความจาก Alpha · ${a.slice(0, 8)}]\nhello from A`);
    await until(() => lastLinks(msgs)?.[0]?.forwards === 1);

    // pause / resume over the socket
    ws.send(JSON.stringify({ type: 'link_pause', reqId: 'p1', linkId: ack.linkId, paused: true }));
    expect((await ackFor(msgs, 'p1')).ok).toBe(true);
    await until(() => lastLinks(msgs)?.[0]?.paused === true);
    children[0].emitLine({ type: 'result', subtype: 'success', is_error: false, result: 'while paused' });
    await tick(80);
    expect(children[1].userTexts()).toHaveLength(2);
    ws.send(JSON.stringify({ type: 'link_pause', reqId: 'p2', linkId: ack.linkId, paused: false }));
    await ackFor(msgs, 'p2');

    // a user message through the web resets the counter
    ws.send(JSON.stringify({ type: 'send', reqId: 'u1', sessionId: b, text: 'hi B' }));
    await ackFor(msgs, 'u1');
    await until(() => lastLinks(msgs)?.[0]?.forwards === 0);

    // closing B removes the link
    ws.send(JSON.stringify({ type: 'close', reqId: 'c1', sessionId: b }));
    await ackFor(msgs, 'c1');
    await until(() => lastLinks(msgs)?.length === 0);

    ws.send(JSON.stringify({ type: 'link_delete', reqId: 'd1', linkId: ack.linkId }));
    expect((await ackFor(msgs, 'd1')).ok).toBe(false); // already gone with B
    ws.close();
  });

  it('link commands are refused when the relay is not enabled', async () => {
    await boot(false);
    const { ws, msgs } = await connect();
    ws.send(JSON.stringify({ type: 'link_create', reqId: 'n1', from: A, to: B }));
    const ack = await ackFor(msgs, 'n1');
    expect(ack.ok).toBe(false);
    ws.close();
  });
});
