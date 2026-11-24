// Remote machines in the browser: command routing by machine, per-machine removal, machine form + status words, canvas edges.
import { describe, expect, it } from 'vitest';
import type { RunnerState, SessionInfo } from '../../shared/protocol';
import { remoteChoices } from './components/useNewJobForm';
import { canvasEdges, layoutCanvas } from './canvas/canvasLayout';
import { EMPTY_MACHINE_FORM, agentLine, formFromMachine, formPayload } from './machineForm';
import type { MachineInfo, SavedSession } from './protocolNext';
import { INITIAL_SERVER_STATE, applyMsg, withMachine } from './useServer';

const sess = (id: string, machineId?: string): SessionInfo => ({
  sessionId: id, pid: 1, name: id, cwd: 'c', kind: 'k', title: id, model: 'haiku', effort: 'low', status: 'idle', thought: '', startedAt: 1, lastActivity: 1, timeline: [], subagents: [], ...(machineId ? { machineId } : {}),
});
const runner = (id: string, machineId?: string): RunnerState => ({
  sessionId: id, cwd: 'c', alive: true, pid: 2, busy: false, queued: 0, model: 'haiku', effort: 'low', confirmed: true, permissionMode: 'default', remoteControl: false, pending: [], startedAt: 1, ...(machineId ? { machineId } : {}),
});
const mach = (over: Partial<MachineInfo> = {}): MachineInfo => ({ id: 'm1', name: 'server', host: 'h', user: 'u', keyPath: '', shell: 'cmd', notes: '', reach: 'online', ssh: 'ok', lastCheck: null, ...over });

describe('withMachine (command routing)', () => {
  const st = {
    sessions: [sess('local'), sess('rem', 'm1')],
    runners: { rr: runner('rr', 'm2') },
    saved: [{ sessionId: 'sv', machineId: 'm1' } as SavedSession, { sessionId: 'sl' } as SavedSession],
  };
  it('stamps the machine of a remote session on routable commands', () => {
    expect(withMachine({ type: 'send', sessionId: 'rem', text: 'hi' }, st)).toMatchObject({ machineId: 'm1' });
    expect(withMachine({ type: 'close', sessionId: 'rem' }, st)).toMatchObject({ machineId: 'm1' });
    expect(withMachine({ type: 'answer', sessionId: 'rem', requestId: 'q', behavior: 'allow' }, st)).toMatchObject({ machineId: 'm1' });
    expect(withMachine({ type: 'set_model', sessionId: 'rr', model: 'haiku' }, st)).toMatchObject({ machineId: 'm2' }); // runner only
    expect(withMachine({ type: 'saved_resume', sessionId: 'sv' }, st)).toMatchObject({ machineId: 'm1' });
  });
  it('leaves local sessions, machine_* messages and explicit machineIds alone', () => {
    const local = { type: 'send' as const, sessionId: 'local', text: 'hi' };
    expect(withMachine(local, st)).toBe(local);
    expect(withMachine({ type: 'saved_resume', sessionId: 'sl' }, st)).not.toHaveProperty('machineId');
    const attach = { type: 'machine_attach' as const, sessionId: 'rem', machineId: 'mX' };
    expect(withMachine(attach, st)).toBe(attach);
    const start = { type: 'start' as const, cwd: 'c', model: 'haiku', effort: 'low' as const, prompt: 'p', machineId: 'm1' };
    expect(withMachine(start, st)).toBe(start);
    const unknown = { type: 'send' as const, sessionId: 'nobody', text: 'x' };
    expect(withMachine(unknown, st)).toBe(unknown);
  });
});

describe('reducer: removals of a remote machine', () => {
  it('removed with a machineId only removes that machine\'s session', () => {
    const s0 = { ...INITIAL_SERVER_STATE, sessions: [sess('x', 'm1')] };
    expect(applyMsg(s0, { type: 'removed', serverTime: 0, sessionId: 'x', machineId: 'm2' }).sessions).toHaveLength(1);
    expect(applyMsg(s0, { type: 'removed', serverTime: 0, sessionId: 'x', machineId: 'm1' }).sessions).toHaveLength(0);
    expect(applyMsg(s0, { type: 'removed', serverTime: 0, sessionId: 'x' }).sessions).toHaveLength(0); // old servers
  });
  it('runner_removed likewise', () => {
    const s0 = { ...INITIAL_SERVER_STATE, runners: { x: runner('x', 'm1') } };
    expect(Object.keys(applyMsg(s0, { type: 'runner_removed', serverTime: 0, sessionId: 'x', machineId: 'm2' }).runners)).toEqual(['x']);
    expect(Object.keys(applyMsg(s0, { type: 'runner_removed', serverTime: 0, sessionId: 'x', machineId: 'm1' }).runners)).toEqual([]);
  });
});

describe('machine form and status words', () => {
  it('the agent toggle round-trips through the form and the payload', () => {
    expect(formFromMachine(mach({ agent: true })).agent).toBe(true);
    expect(formFromMachine(mach()).agent).toBe(false);
    expect(formPayload({ ...EMPTY_MACHINE_FORM, name: 'a', host: 'h', user: 'u', agent: true }).agent).toBe(true);
    expect(formPayload({ ...EMPTY_MACHINE_FORM, name: 'a', host: 'h', user: 'u' }).agent).toBe(false);
  });
  it('agentLine words', () => {
    expect(agentLine(mach())).toBe('');
    expect(agentLine(mach({ agent: true }))).toBe('กำลังเชื่อมต่อ…');
    expect(agentLine(mach({ agent: true, agentState: 'online' }))).toBe('ดู Claude ได้');
    expect(agentLine(mach({ agent: true, agentState: 'error', agentError: 'SSH หลุด' }))).toBe('เชื่อมต่อไม่ได้: SSH หลุด');
  });
  it('only connected agent machines are offered for a new job', () => {
    const list = [mach({ id: 'a' }), mach({ id: 'b', agent: true, agentState: 'online' }), mach({ id: 'c', agent: true, agentState: 'error' }), mach({ id: 'd', agent: true, agentState: 'connecting' })];
    expect(remoteChoices(list).map((m) => m.id)).toEqual(['b']);
    expect(remoteChoices(undefined)).toEqual([]);
  });
});

describe('canvas edges', () => {
  it('a remote session hangs from its machine point, a local one from the local machine node', () => {
    const lay = layoutCanvas([{ sessionId: 'a', subagents: [] }, { sessionId: 'b', subagents: [] }], { now: 0 });
    const local = canvasEdges(lay).filter((e) => e.kind === 'machine');
    const withOrigin = canvasEdges(lay, new Map([['b', { x: 10, y: 500 }]])).filter((e) => e.kind === 'machine');
    expect(withOrigin.find((e) => e.sessionId === 'a')!.d).toBe(local.find((e) => e.sessionId === 'a')!.d);
    expect(withOrigin.find((e) => e.sessionId === 'b')!.d).not.toBe(local.find((e) => e.sessionId === 'b')!.d);
    expect(withOrigin.find((e) => e.sessionId === 'b')!.d.startsWith('M 10')).toBe(true);
  });
});
