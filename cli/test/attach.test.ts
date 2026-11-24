import { describe, expect, it } from 'vitest';
import type { PendingRequest, RunnerState, ServerMsg, SessionInfo, TimelineEvent } from '../../shared/protocol.ts';
import { AttachController } from '../src/attach.ts';
import { applyMessage, emptyState } from '../src/client.ts';
import { makePaint } from '../src/format.ts';

const SID = 'aaaa1111-0000-4000-8000-000000000001';
const runner = (over: Partial<RunnerState> = {}): RunnerState => ({
  sessionId: SID,
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
const session = (timeline: TimelineEvent[]): SessionInfo => ({
  sessionId: SID,
  pid: 1,
  name: 'n',
  cwd: 'C:\\w',
  kind: 'sdk',
  title: 't',
  model: null,
  effort: null,
  status: 'idle',
  thought: '',
  startedAt: 0,
  lastActivity: 0,
  timeline,
  subagents: [],
});
const ev = (ts: number, kind: TimelineEvent['kind'], text: string): TimelineEvent => ({ ts, kind, text });
const permission: PendingRequest = { requestId: 'r1', toolUseId: 'u1', toolName: 'Bash', kind: 'permission', description: 'ls', label: 'Bash: ls', inputPreview: '{}', at: 0 };

function mk() {
  const printed: string[][] = [];
  const sent: Record<string, unknown>[] = [];
  const exits: Array<[number, string | undefined]> = [];
  const c = new AttachController({
    sessionId: SID,
    paint: makePaint(false),
    send: async (cmd) => {
      sent.push(cmd);
      return { ok: true };
    },
    print: (l) => printed.push(l),
    exit: (code, msg) => exits.push([code, msg]),
  });
  return { c, printed, sent, exits, text: () => printed.flat().join('\n') };
}

describe('AttachController', () => {
  it('prints new timeline events once and shows busy / idle changes', () => {
    const t = mk();
    t.c.onUpdate(session([ev(1, 'user', 'hi')]), runner({ busy: true }));
    t.c.onUpdate(session([ev(1, 'user', 'hi'), ev(2, 'text', 'hello')]), runner({ busy: true }));
    t.c.onUpdate(session([ev(1, 'user', 'hi'), ev(2, 'text', 'hello')]), runner());
    expect(t.text()).toBe('> hi\n⏺ hello\n✻ ว่าง');
  });

  it('a typed line is sent as a user message and not echoed back from the timeline', async () => {
    const t = mk();
    t.c.onUpdate(session([]), runner());
    await t.c.onLine('ทำต่อ');
    expect(t.sent).toEqual([{ type: 'send', sessionId: SID, text: 'ทำต่อ' }]);
    t.c.onUpdate(session([ev(5, 'user', 'ทำต่อ'), ev(6, 'text', 'ok')]), runner({ busy: true }));
    expect(t.text()).toContain('⏺ ok');
    expect(t.text()).not.toContain('> ทำต่อ');
  });

  it('a message that came from the web shows up as a user line', () => {
    const t = mk();
    t.c.onUpdate(session([]), runner());
    t.c.onUpdate(session([ev(7, 'user', 'จากเว็บ')]), runner({ busy: true }));
    expect(t.text()).toContain('> จากเว็บ');
  });

  it('a pending permission is shown, the typed number answers it, then normal lines go back to messages', async () => {
    const t = mk();
    t.c.onUpdate(session([]), runner({ pending: [permission] }));
    expect(t.text()).toContain('ขออนุญาตใช้เครื่องมือ: Bash: ls');
    expect(t.c.prompt()).toContain('อนุญาต');
    await t.c.onLine('1');
    expect(t.sent).toEqual([{ type: 'answer', sessionId: SID, requestId: 'r1', behavior: 'allow' }]);
    expect(t.c.prompt()).toBe('cr> ');
    await t.c.onLine('next');
    expect(t.sent[1]).toMatchObject({ type: 'send', text: 'next' });
  });

  it('a question answered on the web is dropped from the terminal', () => {
    const t = mk();
    t.c.onUpdate(session([]), runner({ pending: [permission] }));
    t.c.onUpdate(session([]), runner());
    expect(t.text()).toContain('ถูกตอบจากที่อื่นแล้ว');
    expect(t.c.prompt()).toBe('cr> ');
  });

  it('/close asks first; y closes and leaves, anything else keeps the job', async () => {
    const t = mk();
    t.c.onUpdate(session([]), runner());
    await t.c.onLine('/close');
    expect(t.c.prompt()).toContain('y/n');
    await t.c.onLine('n');
    expect(t.sent).toEqual([]);
    expect(t.exits).toEqual([]);
    await t.c.onLine('/close');
    await t.c.onLine('y');
    expect(t.sent).toEqual([{ type: 'close', sessionId: SID }]);
    expect(t.exits).toHaveLength(1);
    expect(t.exits[0][0]).toBe(0);
  });

  it('/detach leaves without closing; /stop interrupts; empty line does nothing', async () => {
    const t = mk();
    t.c.onUpdate(session([]), runner());
    await t.c.onLine('');
    await t.c.onLine('/stop');
    expect(t.sent).toEqual([{ type: 'stop', sessionId: SID }]);
    await t.c.onLine('/detach');
    expect(t.exits).toHaveLength(1);
    expect(t.sent).toHaveLength(1);
  });

  it('leaves when the job ends or is removed; settled reflects idle', () => {
    const t = mk();
    t.c.onUpdate(session([]), runner({ busy: true }));
    expect(t.c.settled).toBe(false);
    t.c.onUpdate(session([]), runner());
    expect(t.c.settled).toBe(true);
    t.c.onUpdate(session([]), runner({ alive: false, error: 'exit 1' }));
    expect(t.exits).toHaveLength(1);
    expect(t.exits[0][1]).toContain('exit 1');
    const u = mk();
    u.c.onGone();
    expect(u.exits[0][0]).toBe(0);
  });
});

describe('applyMessage', () => {
  it('keeps sessions, runners and the saved list in step with the server', () => {
    const st = emptyState();
    applyMessage(st, { type: 'snapshot', machine: 'm', serverTime: 0, sessions: [session([])], runners: [runner()], saved: [], cwds: ['C:\\w'] });
    expect(st.sessions.has(SID)).toBe(true);
    expect(st.runners.get(SID)?.busy).toBe(false);
    applyMessage(st, { type: 'runner', serverTime: 0, runner: runner({ busy: true }) });
    expect(st.runners.get(SID)?.busy).toBe(true);
    expect(applyMessage(st, { type: 'ping', serverTime: 0 } as ServerMsg)).toBe(false);
    applyMessage(st, { type: 'runner_removed', serverTime: 0, sessionId: SID });
    expect(st.runners.size).toBe(0);
  });
});

describe('queued messages and /now', () => {
  it('prints a notice when messages queue up, and a /now with y/n confirm sends send_now', async () => {
    const m = mk();
    m.c.onUpdate(session([ev(1, 'tool', 'Bash: sleep 60')]), runner({ busy: true, queued: 2, queuedTexts: [{ text: 'one', at: 1 }, { text: 'two', at: 2 }] }));
    const out = m.text();
    expect(out).toContain('ข้อความรอส่ง 2');
    expect(out).toContain('• one');
    expect(out).toContain('กำลังรันอยู่: Bash: sleep 60');
    expect(out).toContain('/now');
    await m.c.onLine('/now');
    expect(m.c.prompt()).toContain('(y/n)');
    await m.c.onLine('n');
    expect(m.sent).toHaveLength(0);
    await m.c.onLine('/now');
    await m.c.onLine('y');
    expect(m.sent).toEqual([{ type: 'send_now', sessionId: SID }]);
  });

  it('/now with nothing queued sends nothing', async () => {
    const m = mk();
    m.c.onUpdate(session([]), runner({ busy: true, queued: 0 }));
    await m.c.onLine('/now');
    expect(m.sent).toHaveLength(0);
    expect(m.text()).toContain('ไม่มีข้อความรอส่ง');
  });
});
