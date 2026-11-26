import { describe, expect, it } from 'vitest';
import { APP_LOCK_CLOSE_CODE, type ServerMsg, type SessionInfo } from '../../shared/protocol';
import type { AccountInfo } from '../../shared/accounts';
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

describe('main login and app lock state', () => {
  it('starts with no main login event and the app unlocked', () => {
    expect(INITIAL_SERVER_STATE.mainLogin).toBeNull();
    expect(INITIAL_SERVER_STATE.appLocked).toBe(false);
  });

  it('main_login stores the latest event and keeps the account list', () => {
    const base = applyMsg(INITIAL_SERVER_STATE, { type: 'accounts', serverTime: 1, accounts: [], defaultId: 'terminal', ptyAvailable: true }, 5);
    const s1 = applyMsg(base, { type: 'main_login', serverTime: 2, event: { status: 'waiting_browser', url: 'https://claude.ai/oauth', needCode: true } }, 9);
    expect(s1.mainLogin).toEqual({ status: 'waiting_browser', url: 'https://claude.ai/oauth', needCode: true });
    expect(s1.lastMessageAt).toBe(9);
    expect(s1.ptyAvailable).toBe(true);
    const s2 = applyMsg(s1, { type: 'main_login', serverTime: 3, event: { status: 'failed', error: 'LOGIN_FAILED' } }, 10);
    expect(s2.mainLogin).toEqual({ status: 'failed', error: 'LOGIN_FAILED' });
  });

  it('parseMsg accepts a main_login with a status and rejects one without', () => {
    expect(parseMsg(JSON.stringify({ type: 'main_login', serverTime: 1, event: { status: 'success' } }))).not.toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'main_login', serverTime: 1, event: {} }))).toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'main_login', serverTime: 1 }))).toBeNull();
  });

  it('the app-lock action sets and clears appLocked without touching the rest', () => {
    const locked = serverReducer(INITIAL_SERVER_STATE, { kind: 'appLocked', locked: true });
    expect(locked.appLocked).toBe(true);
    expect(locked.sessions).toBe(INITIAL_SERVER_STATE.sessions);
    const open = serverReducer(locked, { kind: 'appLocked', locked: false });
    expect(open.appLocked).toBe(false);
  });

  it('the connected action leaves appLocked alone', () => {
    const locked = serverReducer(INITIAL_SERVER_STATE, { kind: 'appLocked', locked: true });
    expect(serverReducer(locked, { kind: 'connected', connected: false }).appLocked).toBe(true);
  });

  it('the close code the server uses for a refused app lock is 4401', () => {
    expect(APP_LOCK_CLOSE_CODE).toBe(4401);
  });
});

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

describe('account messages', () => {
  const acc = (id: string, over: Partial<AccountInfo> = {}): AccountInfo => ({
    id, name: id, color: '#22c55e', letter: 'A', note: '', builtin: false, tokenState: 'unset', fingerprint: null,
    createdAt: 1, tokenAt: null, expiresAt: null, lastCheckAt: null, lastCheckOk: null, usage: null, hidden: false, locked: false, hasPassword: false, ...over,
  });

  it('starts with no accounts, the terminal default and no pty', () => {
    expect(INITIAL_SERVER_STATE.accounts).toEqual([]);
    expect(INITIAL_SERVER_STATE.defaultAccountId).toBe('terminal');
    expect(INITIAL_SERVER_STATE.ptyAvailable).toBe(false);
    expect(INITIAL_SERVER_STATE.connect).toBeNull();
  });

  it('accounts message replaces the list, default and pty flag', () => {
    const msg: ServerMsg = { type: 'accounts', serverTime: 1, accounts: [acc('a')], defaultId: 'a', ptyAvailable: true };
    const s = applyMsg(INITIAL_SERVER_STATE, msg, 50);
    expect(s.accounts.map((a) => a.id)).toEqual(['a']);
    expect(s.defaultAccountId).toBe('a');
    expect(s.ptyAvailable).toBe(true);
    expect(s.lastMessageAt).toBe(50);
  });

  it('account_connect stores the latest event and keeps the list', () => {
    const base = applyMsg(INITIAL_SERVER_STATE, { type: 'accounts', serverTime: 1, accounts: [acc('a')], defaultId: 'terminal', ptyAvailable: false });
    const s = applyMsg(base, { type: 'account_connect', serverTime: 2, event: { accountId: 'a', status: 'waiting_browser', url: 'https://claude.ai/x' } });
    expect(s.connect).toEqual({ accountId: 'a', status: 'waiting_browser', url: 'https://claude.ai/x' });
    expect(s.accounts).toHaveLength(1);
    const done = applyMsg(s, { type: 'account_connect', serverTime: 3, event: { accountId: 'a', status: 'done', checkOk: true } });
    expect(done.connect?.status).toBe('done');
  });

  it('snapshot carries accounts only when present', () => {
    const snap = (extra: object): ServerMsg => ({ type: 'snapshot', machine: 'm', serverTime: 1, sessions: [], ...extra }) as ServerMsg;
    const withAcc = applyMsg(INITIAL_SERVER_STATE, snap({ accounts: [acc('x')], defaultAccountId: 'x', ptyAvailable: true }));
    expect(withAcc.accounts.map((a) => a.id)).toEqual(['x']);
    expect(withAcc.defaultAccountId).toBe('x');
    expect(withAcc.ptyAvailable).toBe(true);
    const without = applyMsg(withAcc, snap({}));
    expect(without.accounts).toBe(withAcc.accounts);
    expect(without.defaultAccountId).toBe('x');
    expect(without.ptyAvailable).toBe(true);
  });

  it('parseMsg accepts well-formed account messages and rejects broken ones', () => {
    expect(parseMsg(JSON.stringify({ type: 'accounts', serverTime: 1, accounts: [], defaultId: 'terminal', ptyAvailable: false }))).not.toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'accounts', serverTime: 1, accounts: 'no', defaultId: 'terminal' }))).toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'account_connect', serverTime: 1, event: { accountId: 'a', status: 'done' } }))).not.toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'account_connect', serverTime: 1, event: { status: 'done' } }))).toBeNull();
  });
});

describe('resolveApiBase', () => {
  it('uses the served port in production and 8790 in dev', () => {
    expect(resolveApiBase('127.0.0.1', '8793')).toBe('http://127.0.0.1:8793');
    expect(resolveApiBase('', undefined)).toBe('http://127.0.0.1:8790');
  });
});
