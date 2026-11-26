import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID, type AccountInfo } from '../../shared/accounts';
import type { RunnerState } from '../../shared/protocol';
import type { UsageSnapshot } from '../../shared/usage';
import {
  TOAST_HIDE_MS,
  barWidth,
  idleJobsToMove,
  isOutside,
  moveErrorText,
  pctText,
  popoverBadge,
  popoverModel,
  popoverSubline,
  summarizeMoves,
} from './accountMenuLogic';
import { setLanguage } from './i18n';
import { th } from './i18n/th';
import { en } from './i18n/en';

const NOW = 1_800_000_000_000;

function acct(id: string, over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id,
    name: id.toUpperCase(),
    color: ACCOUNT_COLORS[0],
    letter: id[0]!.toUpperCase(),
    note: '',
    builtin: false,
    tokenState: 'set',
    fingerprint: null,
    createdAt: 1,
    tokenAt: null,
    expiresAt: null,
    lastCheckAt: null,
    lastCheckOk: null,
    usage: null,
    hidden: false,
    locked: false, hasPassword: false,
    ...over,
  };
}

function runner(id: string, over: Partial<RunnerState> = {}): RunnerState {
  return {
    sessionId: id,
    cwd: 'C:/x',
    alive: true,
    pid: 1,
    busy: false,
    queued: 0,
    model: null,
    effort: null,
    confirmed: false,
    permissionMode: 'default' as RunnerState['permissionMode'],
    remoteControl: false,
    pending: [],
    startedAt: 1,
    ...over,
  };
}

afterEach(() => setLanguage('th', { persist: false }));

describe('popoverModel', () => {
  it('current is the default profile; others are the visible rest, default left out', () => {
    const list = [acct('terminal', { name: 'Terminal', letter: 'T', builtin: true }), acct('work'), acct('home')];
    const m = popoverModel(list, 'work');
    expect(m.current.id).toBe('work');
    expect(m.fallback).toBe(false);
    expect(m.others.map((a) => a.id)).toEqual(['terminal', 'home']);
  });

  it('hides hidden profiles from the others but always shows a hidden current one', () => {
    const list = [acct('terminal', { builtin: true, hidden: true }), acct('work', { hidden: true }), acct('home', { hidden: true }), acct('x')];
    const m = popoverModel(list, 'work');
    expect(m.current.id).toBe('work');
    expect(m.others.map((a) => a.id)).toEqual(['x']);
  });

  it('reads 5 h and 7 d usage of the current profile; unknown stays null', () => {
    const withUsage = acct('work', {
      usage: { fiveHour: { pct: 41.4, resetsAt: null }, sevenDay: { pct: 72.6, resetsAt: null }, updatedAt: NOW },
    });
    expect(popoverModel([withUsage], 'work')).toMatchObject({ five: 41, seven: 73 });
    expect(popoverModel([acct('work')], 'work')).toMatchObject({ five: null, seven: null });
  });

  it('no accounts (old server) gives the Terminal fallback with no others', () => {
    const m = popoverModel([], 'terminal');
    expect(m.fallback).toBe(true);
    expect(m.current.id).toBe(TERMINAL_ACCOUNT_ID);
    expect(m.others).toEqual([]);
    expect(m.five).toBeNull();
    expect(m.seven).toBeNull();
  });

  it('only the built-in profile gives no others', () => {
    const m = popoverModel([acct('terminal', { builtin: true, name: 'Terminal' })], 'terminal');
    expect(m.fallback).toBe(false);
    expect(m.current.id).toBe('terminal');
    expect(m.others).toEqual([]);
  });

  it('unknown default id falls back to the first profile', () => {
    const m = popoverModel([acct('a'), acct('b')], 'gone');
    expect(m.current.id).toBe('a');
    expect(m.others.map((a) => a.id)).toEqual(['b']);
  });
});

describe('bars and percent text', () => {
  it('clamps the bar width to 0..100 and treats unknown as empty', () => {
    expect(barWidth(null)).toBe(0);
    expect(barWidth(Number.NaN)).toBe(0);
    expect(barWidth(-5)).toBe(0);
    expect(barWidth(64)).toBe(64);
    expect(barWidth(250)).toBe(100);
  });

  it('shows a dash for unknown usage', () => {
    expect(pctText(null)).toBe('—');
    expect(pctText(12)).toBe('12%');
  });
});

describe('idleJobsToMove', () => {
  it('picks alive, idle, queue-free, local jobs that are not on the target and have no pending switch', () => {
    const runners = {
      ok: runner('ok', { accountId: 'a' }),
      noAccount: runner('noAccount'),
      busy: runner('busy', { busy: true }),
      queued: runner('queued', { queued: 2 }),
      dead: runner('dead', { alive: false }),
      remote: runner('remote', { machineId: 'm1' }),
      onTarget: runner('onTarget', { accountId: 'target' }),
      pending: runner('pending', { accountPending: 'b' }),
    };
    expect(idleJobsToMove(runners, 'target').sort()).toEqual(['noAccount', 'ok']);
  });

  it('returns nothing for an empty runner map', () => {
    expect(idleJobsToMove({}, 'x')).toEqual([]);
  });
});

describe('summarizeMoves', () => {
  it('counts successes and keeps the first error', () => {
    expect(
      summarizeMoves([
        { ok: true },
        { ok: false, error: 'srv.account.noToken' },
        { ok: false, error: 'NETWORK' },
        { ok: true },
      ]),
    ).toEqual({ moved: 2, firstError: 'srv.account.noToken' });
  });

  it('no error when all moved', () => {
    expect(summarizeMoves([{ ok: true }])).toEqual({ moved: 1, firstError: null });
  });
});

describe('moveErrorText and isOutside', () => {
  it('maps srv codes and API codes to text in the current language', () => {
    setLanguage('en', { persist: false });
    expect(moveErrorText('SERVER_ERROR')).toBe(en['acct.err.SERVER_ERROR']);
    expect(moveErrorText('srv.unknown.code')).toBe(en['acct.err.SERVER_ERROR']);
    setLanguage('th', { persist: false });
    expect(moveErrorText('NOT_FOUND')).toBe(th['acct.err.NOT_FOUND']);
  });

  it('outside means: no root, or the target is not inside the root', () => {
    const inside = { contains: (n: unknown) => n === 'in' };
    expect(isOutside(null, 'in')).toBe(true);
    expect(isOutside(inside, 'in')).toBe(false);
    expect(isOutside(inside, 'out')).toBe(true);
  });

  it('toast hides after about 8 seconds', () => {
    expect(TOAST_HIDE_MS).toBe(8000);
  });
});

describe('acct.pop i18n keys', () => {
  it('every acct.pop key exists in th and en', () => {
    const keys = Object.keys(th).filter((k) => k.startsWith('acct.pop.'));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(en).toHaveProperty([k]);
  });
});

describe('popover rows: main account and token profiles', () => {
  const main = { loggedIn: true, email: 'alice@example.com', plan: 'Max', orgName: null, expiresAt: null, checkedAt: NOW };
  const terminal = acct('terminal', { name: 'Terminal', letter: 'T', builtin: true, tokenState: 'unset', main });
  const usage: UsageSnapshot = {
    fiveHour: null,
    sevenDay: { pct: 72.6, resetsAt: null, updatedAt: NOW, sessionId: null, model: null },
    sessions: [],
  };

  it('the main row sub-line is the masked email, never the full address', () => {
    const sub = popoverSubline(terminal);
    expect(sub).toMatch(/@example\.com$/);
    expect(sub).not.toContain('alice');
  });

  it('the main row badge is the week % of the global usage snapshot, and nothing without one', () => {
    expect(popoverBadge(terminal, NOW, usage)).toEqual({ kind: 'week', pct: 73 });
    expect(popoverBadge(terminal, NOW)).toEqual({ kind: 'none' });
    expect(popoverBadge(terminal, NOW, { fiveHour: null, sevenDay: null, sessions: [] })).toEqual({ kind: 'none' });
  });

  it('a token profile shows its note as sub-line, nothing when it has no note', () => {
    expect(popoverSubline(acct('work', { note: '  งานหลัก ' }))).toBe('งานหลัก');
    expect(popoverSubline(acct('work', { note: '' }))).toBe('');
  });

  it('a token profile badge is its own week % or the red limit badge', () => {
    const weekly = acct('work', { usage: { fiveHour: null, sevenDay: { pct: 40, resetsAt: null }, updatedAt: NOW } });
    expect(popoverBadge(weekly, NOW, usage)).toEqual({ kind: 'week', pct: 40 });
    const limited = acct('work', { usage: { fiveHour: { pct: 100, resetsAt: NOW + 3600_000 }, sevenDay: null, updatedAt: NOW } });
    expect(popoverBadge(limited, NOW)).toEqual({ kind: 'limit' });
  });

  it('the current block of the model carries builtin and main so the avatar shows the email letter', () => {
    const m = popoverModel([terminal], 'terminal');
    expect(m.current).toMatchObject({ builtin: true, main });
    expect(popoverModel([], 'x').current.builtin).toBe(true);
  });
});

describe('popoverModel with the global usage snapshot', () => {
  const MAIN = acct(TERMINAL_ACCOUNT_ID, { name: 'Terminal login', builtin: true, tokenState: 'unset' });
  const WORK = acct('work', { name: 'Work', usage: { fiveHour: null, sevenDay: { pct: 40, resetsAt: null }, updatedAt: NOW } });
  const GLOBAL_SNAP: UsageSnapshot = {
    fiveHour: { pct: 35.2, resetsAt: NOW + 3600_000, updatedAt: NOW, sessionId: null, model: null },
    sevenDay: { pct: 73.4, resetsAt: NOW + 86_400_000, updatedAt: NOW, sessionId: null, model: null },
    sessions: [],
  };

  it('shows the main account bars from the global snapshot when it is the current profile', () => {
    const m = popoverModel([MAIN, WORK], TERMINAL_ACCOUNT_ID, GLOBAL_SNAP);
    expect(m.five).toBe(35);
    expect(m.seven).toBe(73);
    expect(pctText(m.five)).toBe('35%');
  });

  it('shows dashes for the main account without a global snapshot', () => {
    const m = popoverModel([MAIN, WORK], TERMINAL_ACCOUNT_ID);
    expect(m.five).toBeNull();
    expect(pctText(m.five)).toBe('—');
  });

  it('keeps a token profile on its own usage', () => {
    const m = popoverModel([MAIN, WORK], 'work', GLOBAL_SNAP);
    expect(m.five).toBeNull();
    expect(m.seven).toBe(40);
  });

  it('gives the main account its week badge in the list from the global snapshot', () => {
    expect(popoverBadge(MAIN, NOW, GLOBAL_SNAP)).toEqual({ kind: 'week', pct: 73 });
  });
});
