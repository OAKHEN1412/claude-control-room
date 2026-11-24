// Terminal as a second client: open-in-terminal availability, the hint for read-only terminal sessions, the command shape.
import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../../shared/protocol';
import { TAKEOVER_BUSY_TITLE, TAKEOVER_TITLE, canOpenTerminal, shortId, takeoverGate, terminalHint } from './control';
import { createCommander } from './commands';
import { withMachine } from './useServer';

const SID = '123e4567-e89b-42d3-a456-426614174000';

describe('terminal as a second client', () => {
  it('open-in-terminal only for a live Runner job', () => {
    expect(canOpenTerminal('runner')).toBe(true);
    expect(canOpenTerminal('readonly')).toBe(false);
    expect(canOpenTerminal('adoptable')).toBe(false);
  });

  it('a read-only terminal session gets the "cr resume <id>" hint; other modes get none', () => {
    expect(shortId(SID)).toBe('123e4567');
    const hint = terminalHint('readonly', SID);
    expect(hint).toContain('cr resume 123e4567');
    expect(hint).toContain('ย้ายมาคุมจากเว็บ');
    expect(terminalHint('runner', SID)).toBeNull();
    expect(terminalHint('adoptable', SID)).toBeNull();
  });

  it('the hint names the take-over button first', () => {
    expect(terminalHint('readonly', SID)).toContain('ยึดมาคุม');
  });

  it('take-over button state: only a live terminal session that is idle', () => {
    const idle = { status: 'idle' as const, subagents: [] };
    expect(takeoverGate(idle, 'readonly')).toMatchObject({ enabled: true, title: TAKEOVER_TITLE });
    for (const status of ['running', 'waiting', 'unreadable'] as const) {
      expect(takeoverGate({ ...idle, status }, 'readonly')).toEqual({ enabled: false, title: TAKEOVER_BUSY_TITLE });
    }
    const ask = { id: 'x', kind: 'ask' as const, toolName: 'AskUserQuestion', label: '', detail: '', at: 1 };
    expect(takeoverGate({ ...idle, waitItems: [ask] }, 'readonly').enabled).toBe(false);
    const sub = { id: 'a', description: '', model: null, effort: null, status: 'running' as const, thought: '', finished: false, lastActivity: 1 };
    expect(takeoverGate({ ...idle, subagents: [sub] }, 'readonly').enabled).toBe(false);
    expect(takeoverGate({ ...idle, subagents: [{ ...sub, status: 'done', finished: true }] }, 'readonly').enabled).toBe(true);
    // a Runner job or a closed terminal session has its own buttons (adopt / none)
    expect(takeoverGate(idle, 'runner').enabled).toBe(false);
    expect(takeoverGate(idle, 'adoptable').enabled).toBe(false);
  });

  it('takeover goes out as a normal command; machineId routes it to a remote agent', async () => {
    const sent: string[] = [];
    const c = createCommander((t) => (sent.push(t), true));
    const cmd = withMachine({ type: 'takeover', sessionId: SID }, { sessions: [{ sessionId: SID, machineId: 'm1' } as SessionInfo], runners: {}, saved: [] });
    expect(cmd).toMatchObject({ type: 'takeover', machineId: 'm1' });
    const p = c.send(cmd);
    const msg = JSON.parse(sent[0]);
    expect(msg).toMatchObject({ type: 'takeover', sessionId: SID, machineId: 'm1' });
    c.onMessage({ type: 'ack', serverTime: 0, reqId: msg.reqId, ok: false, error: 'งานนี้กำลังทำงานอยู่ รอให้ว่างก่อน' });
    await expect(p).resolves.toMatchObject({ ok: false, error: 'งานนี้กำลังทำงานอยู่ รอให้ว่างก่อน' });
  });

  it('open_terminal goes out as a normal command with a reqId', async () => {
    const sent: string[] = [];
    const c = createCommander((t) => (sent.push(t), true));
    const p = c.send({ type: 'open_terminal', sessionId: SID });
    const msg = JSON.parse(sent[0]);
    expect(msg).toMatchObject({ type: 'open_terminal', sessionId: SID });
    c.onMessage({ type: 'ack', serverTime: 0, reqId: msg.reqId, ok: true, sessionId: SID });
    await expect(p).resolves.toMatchObject({ ok: true, sessionId: SID });
  });
});
