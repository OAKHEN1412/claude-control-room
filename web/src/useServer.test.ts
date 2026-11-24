import { describe, expect, it } from 'vitest';
import type { ServerMsg, SessionInfo } from '../../shared/protocol';
import {
  BACKOFF_MAX_MS,
  resolveApiBase,
  INITIAL_SERVER_STATE,
  applyMsg,
  isDemoSearch,
  isLive,
  nextDelay,
  parseMsg,
  resolveWsUrl,
  serverReducer,
} from './useServer';

function session(id: string, status: SessionInfo['status'] = 'running'): SessionInfo {
  return {
    sessionId: id,
    pid: 1,
    name: id,
    cwd: 'C:\\x',
    kind: 'interactive',
    title: id,
    model: null,
    effort: null,
    status,
    thought: '',
    startedAt: 0,
    lastActivity: 0,
    timeline: [],
    subagents: [],
  };
}

describe('applyMsg', () => {
  it('snapshot replaces machine, sessions and sets lastMessageAt', () => {
    const start = { ...INITIAL_SERVER_STATE, sessions: [session('old')] };
    const msg: ServerMsg = { type: 'snapshot', machine: 'desktop-demo', serverTime: 5, sessions: [session('a'), session('b')] };
    const next = applyMsg(start, msg, 1000);
    expect(next.machine).toBe('desktop-demo');
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(next.lastMessageAt).toBe(1000);
  });

  it('session upserts: replaces an existing id and appends a new one', () => {
    let st = applyMsg(INITIAL_SERVER_STATE, { type: 'snapshot', machine: 'm', serverTime: 0, sessions: [session('a', 'running')] }, 1);
    st = applyMsg(st, { type: 'session', serverTime: 0, session: session('a', 'waiting') }, 2);
    st = applyMsg(st, { type: 'session', serverTime: 0, session: session('c', 'idle') }, 3);
    expect(st.sessions.map((s) => [s.sessionId, s.status])).toEqual([
      ['a', 'waiting'],
      ['c', 'idle'],
    ]);
    expect(st.lastMessageAt).toBe(3);
  });

  it('removed deletes only the named session', () => {
    const st = { ...INITIAL_SERVER_STATE, sessions: [session('a'), session('b')] };
    const next = applyMsg(st, { type: 'removed', serverTime: 0, sessionId: 'a' }, 10);
    expect(next.sessions.map((s) => s.sessionId)).toEqual(['b']);
  });

  it('ping only updates lastMessageAt', () => {
    const st = { ...INITIAL_SERVER_STATE, sessions: [session('a')], machine: 'm' };
    const next = applyMsg(st, { type: 'ping', serverTime: 0 }, 77);
    expect(next.lastMessageAt).toBe(77);
    expect(next.sessions).toBe(st.sessions);
    expect(next.machine).toBe('m');
  });

  it('serverReducer toggles connected without touching data', () => {
    const st = { ...INITIAL_SERVER_STATE, sessions: [session('a')] };
    const open = serverReducer(st, { kind: 'connected', connected: true });
    expect(open.connected).toBe(true);
    expect(open.sessions).toBe(st.sessions);
    expect(serverReducer(open, { kind: 'connected', connected: false }).connected).toBe(false);
  });
});

describe('parseMsg', () => {
  it('accepts known message types and rejects junk', () => {
    expect(parseMsg('{"type":"ping","serverTime":1}')?.type).toBe('ping');
    expect(parseMsg('{"type":"removed","serverTime":1,"sessionId":"x"}')?.type).toBe('removed');
    expect(parseMsg('not json')).toBeNull();
    expect(parseMsg('{"type":"snapshot","machine":5,"sessions":[]}')).toBeNull();
    expect(parseMsg('{"type":"mystery"}')).toBeNull();
    expect(parseMsg('[1,2]')).toBeNull();
  });
});

describe('connection helpers', () => {
  it('builds the default URL from the page host and port 8790, or uses the override', () => {
    expect(resolveWsUrl('desktop-demo.local')).toBe('ws://desktop-demo.local:8790');
    expect(resolveWsUrl('')).toBe('ws://127.0.0.1:8790');
    expect(resolveWsUrl('example', 'ws://10.0.0.5:9000')).toBe('ws://10.0.0.5:9000');
    expect(resolveWsUrl('127.0.0.1', undefined, '8894')).toBe('ws://127.0.0.1:8894');
    expect(resolveWsUrl('127.0.0.1', 'ws://x:1', '8894')).toBe('ws://x:1');
  });

  it('backs off 1 s, 2 s, 4 s, 8 s then caps at 10 s', () => {
    const steps = [1000];
    for (let i = 0; i < 5; i++) steps.push(nextDelay(steps[steps.length - 1]));
    expect(steps).toEqual([1000, 2000, 4000, 8000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
  });

  it('is live only when connected and the last message is under 12 s old', () => {
    expect(isLive(true, 10_000, 15_000)).toBe(true);
    expect(isLive(true, 10_000, 22_000)).toBe(false);
    expect(isLive(false, 10_000, 10_500)).toBe(false);
    expect(isLive(true, null, 10_000)).toBe(false);
  });

  it('detects the ?demo=1 flag', () => {
    expect(isDemoSearch('?demo=1')).toBe(true);
    expect(isDemoSearch('?x=2&demo=1')).toBe(true);
    expect(isDemoSearch('?demo=0')).toBe(false);
    expect(isDemoSearch('')).toBe(false);
  });
});

describe('resolveApiBase', () => {
  it('uses the served port in production and 8790 in dev', () => {
    expect(resolveApiBase('127.0.0.1', '8793')).toBe('http://127.0.0.1:8793');
    expect(resolveApiBase('', undefined)).toBe('http://127.0.0.1:8790');
  });
});
