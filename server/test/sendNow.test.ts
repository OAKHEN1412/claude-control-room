import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_ROUTABLE } from '../../shared/protocol';
import { parseClientMsg } from '../src/commands';
import { Runner, RunnerSession, combineQueued, type ChildLike } from '../src/runner';

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 99;
  written: Record<string, any>[] = [];
  private buf = '';
  constructor() {
    super();
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
  users(): string[] {
    return this.written.filter((w) => w.type === 'user').map((w) => (typeof w.message.content === 'string' ? w.message.content : JSON.stringify(w.message.content)));
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
const replay = (c: FakeChild, text: string) => c.emitLine({ type: 'user', message: { role: 'user', content: text }, isReplay: true });

describe('queuedTexts lifecycle', () => {
  it('lists unconsumed messages oldest first, drops them as they are consumed, strips secrets, clips long text', async () => {
    const child = new FakeChild();
    const s = new RunnerSession({ sessionId: 's', cwd: 'C:\\x', child, model: 'haiku', effort: 'high' });
    expect(s.state().queuedTexts).toBeUndefined();
    s.sendUser('first');
    s.sendUser('use sk-ant-abcdefghijklmnopqrstuvwxyz0123 now');
    s.sendUser('x'.repeat(500));
    const st = s.state();
    expect(st.queued).toBe(3);
    expect(st.queuedTexts?.[0].text).toBe('first');
    expect(st.queuedTexts?.[1].text).toContain('[secret]');
    expect(st.queuedTexts?.[1].text).not.toContain('sk-ant');
    expect(st.queuedTexts?.[2].text).toHaveLength(300);
    replay(child, 'first');
    await until(() => s.state().queued === 2);
    expect(s.state().queuedTexts).toHaveLength(2);
    expect(s.state().queuedTexts?.[0].text).toContain('[secret]');
  });

  it('an interrupt clears the list together with the counter', async () => {
    const child = new FakeChild();
    const s = new RunnerSession({ sessionId: 's', cwd: 'C:\\x', child, model: 'haiku', effort: 'high' });
    s.sendUser('a');
    s.sendUser('b');
    s.stop();
    child.emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
    await until(() => s.state().queued === 0);
    expect(s.state().queuedTexts).toBeUndefined();
    expect(s.state().busy).toBe(false);
  });

  it('a dead child has no queue', () => {
    const child = new FakeChild();
    const s = new RunnerSession({ sessionId: 's', cwd: 'C:\\x', child, model: 'haiku', effort: 'high' });
    s.sendUser('a');
    child.emit('exit', 1, null);
    expect(s.state().queued).toBe(0);
    expect(s.state().queuedTexts).toBeUndefined();
  });
});

describe('send_now', () => {
  it('combineQueued joins texts with blank lines and de-duplicates attachment ids', () => {
    expect(
      combineQueued([
        { text: 'one', ids: ['a'] },
        { text: '  ', ids: ['a', 'b'] },
        { text: 'two ', ids: [] },
      ]),
    ).toEqual({ text: 'one\n\ntwo', ids: ['a', 'b'] });
  });

  it('is parsed, is remote-routable, and needs a valid session id', () => {
    expect(REMOTE_ROUTABLE).toContain('send_now');
    expect(parseClientMsg({ type: 'send_now', reqId: 'r1', sessionId: 'abc-1' })).toMatchObject({ ok: true, msg: { type: 'send_now', sessionId: 'abc-1' } });
    expect(parseClientMsg({ type: 'send_now', reqId: 'r1', sessionId: '../x' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'send_now', sessionId: 'abc' }).ok).toBe(false);
  });

  describe('through Runner', () => {
    let tmp: string;
    const children: FakeChild[] = [];
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sendnow-'));
      children.length = 0;
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const mk = () =>
      new Runner({
        allowedCwds: () => [tmp],
        spawn: () => {
          const c = new FakeChild();
          children.push(c);
          return c;
        },
        stopGraceMs: 5000,
        sendNowSettleMs: 120,
      });

    it('interrupts, waits for the turn to end, then sends the queued texts as ONE message', async () => {
      const r = mk();
      const id = r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'run sleep' });
      const c = children[0];
      replay(c, 'run sleep'); // consumed: the turn is running
      await until(() => r.states()[0].queued === 0);
      r.send(id, 'first follow-up');
      r.send(id, 'second follow-up');
      await until(() => r.states()[0].queued === 2);
      const p = r.sendNow(id);
      await until(() => c.written.some((w) => w.request?.subtype === 'interrupt'));
      expect(c.users()).toHaveLength(3); // nothing re-sent before the interrupt finished
      c.emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
      const note = await p;
      expect(note).toContain('2');
      expect(c.users()).toHaveLength(4);
      expect(c.users()[3]).toBe('first follow-up\n\nsecond follow-up');
      const st = r.states()[0];
      expect(st.queued).toBe(1); // the combined message waits for the child to consume it
      expect(st.queuedTexts?.[0].text).toBe('first follow-up\n\nsecond follow-up');
    });

    it('does not send again what the child took by itself after the interrupt (Claude keeps the queue)', async () => {
      const r = mk();
      const id = r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'run' });
      const c = children[0];
      replay(c, 'run');
      await until(() => r.states()[0].queued === 0);
      r.send(id, 'A');
      r.send(id, 'B');
      await until(() => r.states()[0].queued === 2);
      const p = r.sendNow(id);
      await until(() => c.written.some((w) => w.request?.subtype === 'interrupt'));
      c.emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
      c.emitLine({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' }); // the child starts on the kept queue at once (measured: ~150 ms after the result), as one merged turn
      const note = await p;
      expect(note).toContain('ไม่ต้องส่งซ้ำ');
      expect(c.users()).toHaveLength(3); // run, A, B: nothing added
    });

    it('refuses when nothing is queued, and reports it when the child dies instead of stopping', async () => {
      const r = mk();
      const id = r.start({ cwd: tmp, model: 'haiku', effort: 'high', prompt: 'x' });
      const c = children[0];
      replay(c, 'x');
      await until(() => r.states()[0].queued === 0);
      await expect(r.sendNow(id)).rejects.toThrow('ไม่มีข้อความรอส่ง');
      r.send(id, 'later');
      const p = r.sendNow(id);
      c.emit('exit', 1, null);
      await expect(p).rejects.toThrow('หยุดงานไม่สำเร็จ');
    });
  });
});
