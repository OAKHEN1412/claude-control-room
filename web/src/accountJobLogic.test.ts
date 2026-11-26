import { describe, expect, it } from 'vitest';
import { tx } from './i18n';
import { TERMINAL_ACCOUNT_ID, type AccountInfo } from '../../shared/accounts';
import type { RunnerState } from '../../shared/protocol';
import type { UsageSnapshot } from '../../shared/usage';
import { th } from './i18n/th';
import { en } from './i18n/en';
import {
  LOCKED_CODE,
  alternatives,
  isLockedFailure,
  isLockedProfile,
  canSwitch,
  chipModel,
  confirmKey,
  confirmText,
  currentAccountId,
  hasSwitchableToken,
  isLocalJob,
  limitRows,
  nameOfId,
  pendingLabel,
  profileName,
} from './accountJobLogic';

const NOW = 1_800_000_000_000;

function acct(over: Partial<AccountInfo> & { id: string }): AccountInfo {
  return {
    name: over.id,
    color: '#6366f1',
    letter: over.id.slice(0, 1).toUpperCase(),
    note: '',
    builtin: false,
    tokenState: 'set',
    fingerprint: 'abcd1234',
    createdAt: 1,
    tokenAt: 2,
    expiresAt: null,
    lastCheckAt: null,
    lastCheckOk: null,
    usage: null,
    hidden: false,
    locked: false, hasPassword: false,
    ...over,
  };
}

const TERMINAL = acct({ id: TERMINAL_ACCOUNT_ID, name: 'x', builtin: true, tokenState: 'unset', fingerprint: null, letter: 'T' });
const ALICE = acct({ id: 'alice', name: 'Alice' });
const BOB = acct({ id: 'bob', name: 'Bob', usage: { fiveHour: null, sevenDay: { pct: 40, resetsAt: null }, updatedAt: NOW } });
const CAROL = acct({ id: 'carol', name: 'Carol', usage: { fiveHour: null, sevenDay: { pct: 10, resetsAt: null }, updatedAt: NOW } });
const LIMITED = acct({
  id: 'dan',
  name: 'Dan',
  usage: { fiveHour: { pct: 100, resetsAt: NOW + 3600_000 }, sevenDay: { pct: 20, resetsAt: null }, updatedAt: NOW },
});
const HIDDEN = acct({ id: 'hid', name: 'Hidden', hidden: true });
const NO_TOKEN = acct({ id: 'nt', name: 'NoToken', tokenState: 'unset', fingerprint: null });

const ACCOUNTS = [TERMINAL, ALICE, BOB, CAROL, LIMITED, HIDDEN, NO_TOKEN];
const SNAP = { accounts: ACCOUNTS, defaultAccountId: 'alice' };

function runner(over: Partial<RunnerState> = {}): RunnerState {
  return {
    alive: true,
    busy: false,
    queued: 0,
    ...over,
  } as RunnerState;
}

describe('names and avatars', () => {
  it('Terminal profile uses its fixed label, other profiles their own name', () => {
    expect(profileName(TERMINAL)).toBe('บัญชีหลัก');
    expect(profileName(ALICE)).toBe('Alice');
  });

  it('unknown id reads as the id itself', () => {
    expect(nameOfId(ACCOUNTS, 'ghost')).toBe('ghost');
    expect(nameOfId(ACCOUNTS, TERMINAL_ACCOUNT_ID)).toBe('บัญชีหลัก');
  });
});

describe('chipModel', () => {
  it('is hidden without a runner and for a remote job', () => {
    expect(chipModel(undefined, SNAP).visible).toBe(false);
    expect(chipModel(runner({ machineId: 'm1' }), SNAP).visible).toBe(false);
  });

  it('uses the runner accountId and falls back to the default profile', () => {
    expect(chipModel(runner({ accountId: 'bob' }), SNAP).id).toBe('bob');
    const m = chipModel(runner(), SNAP);
    expect(m.id).toBe('alice');
    expect(m.name).toBe('Alice');
    expect(m.avatar).toEqual({ letter: 'A', color: '#6366f1', builtin: false });
  });

  it('shows the id for an unknown profile', () => {
    const m = chipModel(runner({ accountId: 'ghost' }), SNAP);
    expect(m.name).toBe('ghost');
    expect(m.avatar.letter).toBe('?');
  });

  it('is enabled only while the job is alive', () => {
    expect(chipModel(runner({ alive: true }), SNAP).enabled).toBe(true);
    expect(chipModel(runner({ alive: false }), SNAP).enabled).toBe(false);
  });

  it('names the pending target', () => {
    expect(chipModel(runner({ accountPending: 'bob' }), SNAP).pendingName).toBe('Bob');
    expect(chipModel(runner(), SNAP).pendingName).toBeNull();
  });
});

describe('canSwitch and isLocalJob', () => {
  it('canSwitch needs a runner that is alive and not remote', () => {
    expect(canSwitch(undefined)).toBe(false);
    expect(canSwitch(runner({ alive: false }))).toBe(false);
    expect(canSwitch(runner({ machineId: 'm' }))).toBe(false);
    expect(canSwitch(runner())).toBe(true);
  });

  it('isLocalJob is false when either side names a machine', () => {
    expect(isLocalJob(undefined, runner())).toBe(true);
    expect(isLocalJob({ machineId: 'm' }, runner())).toBe(false);
    expect(isLocalJob(undefined, runner({ machineId: 'm' }))).toBe(false);
    expect(isLocalJob(undefined, undefined)).toBe(false);
  });
});

describe('confirm text', () => {
  it('uses the wait sentence while busy and the restart sentence when idle', () => {
    expect(confirmKey(true)).toBe('acct.job.switchWhenBusy');
    expect(confirmKey(false)).toBe('acct.job.switchNow');
    expect(confirmText('Bob', true)).toBe('จะสลับเป็น Bob · รอจบรอบนี้ก่อนแล้วค่อยสลับ (คำสั่งที่ค้างอยู่ไม่หาย)');
    expect(confirmText('Bob', false)).toBe('จะสลับเป็น Bob · งานจะเปิดใหม่ด้วยบัญชีนี้ (ไม่กี่วินาที) บทสนทนาอยู่ครบ');
  });
});

describe('currentAccountId', () => {
  it('prefers runner.accountId, then the default, then the Terminal login', () => {
    expect(currentAccountId(runner({ accountId: 'bob' }), 'alice')).toBe('bob');
    expect(currentAccountId(runner(), 'alice')).toBe('alice');
    expect(currentAccountId(undefined, '')).toBe(TERMINAL_ACCOUNT_ID);
  });
});

describe('alternatives', () => {
  it('excludes the current profile and hidden profiles', () => {
    const ids = alternatives(ACCOUNTS, 'alice', NOW).map((a) => a.id);
    expect(ids).not.toContain('alice');
    expect(ids).not.toContain('hid');
  });

  it('puts limited profiles last, then lowest week % first, unknown usage last', () => {
    const ids = alternatives(ACCOUNTS, 'alice', NOW).map((a) => a.id);
    // carol 10%, bob 40%, then no usage (terminal, nt), then the limited one.
    expect(ids).toEqual(['carol', 'bob', TERMINAL_ACCOUNT_ID, 'nt', 'dan']);
  });

  it('keeps server order on ties', () => {
    const ids = alternatives([ALICE, TERMINAL, NO_TOKEN], 'alice', NOW).map((a) => a.id);
    expect(ids).toEqual([TERMINAL_ACCOUNT_ID, 'nt']);
  });
});

describe('limitRows', () => {
  it('keeps profiles with a token or the Terminal login and drops the rest', () => {
    expect(hasSwitchableToken(NO_TOKEN)).toBe(false);
    expect(hasSwitchableToken(TERMINAL)).toBe(true);
    const ids = limitRows(ACCOUNTS, 'alice', NOW).map((r) => r.account.id);
    expect(ids).not.toContain('nt');
    expect(ids).toContain(TERMINAL_ACCOUNT_ID);
  });

  it('marks limited profiles as disabled with the limit badge', () => {
    const dan = limitRows(ACCOUNTS, 'alice', NOW).find((r) => r.account.id === 'dan');
    expect(dan?.limited).toBe(true);
    expect(dan?.badge).toEqual({ kind: 'limit' });
    const bob = limitRows(ACCOUNTS, 'alice', NOW).find((r) => r.account.id === 'bob');
    expect(bob?.limited).toBe(false);
    expect(bob?.badge).toEqual({ kind: 'week', pct: 40 });
  });
});

describe('pendingLabel', () => {
  it('is null without a pending id and names the target otherwise', () => {
    expect(pendingLabel(undefined, ACCOUNTS)).toBeNull();
    expect(pendingLabel('', ACCOUNTS)).toBeNull();
    expect(pendingLabel('bob', ACCOUNTS)).toBe('รอสลับเป็น Bob…');
    expect(pendingLabel('ghost', ACCOUNTS)).toBe('รอสลับเป็น ghost…');
  });
});

describe('lock handling', () => {
  const LOCKED = { ...ALICE, id: 'locked', name: 'Locked', locked: true, hasPassword: true };
  it('a waiting job names its locked profile and shows the waiting label', () => {
    const r = { alive: false, busy: false, queued: 0, accountId: 'alice', waitingUnlock: 'locked' } as RunnerState;
    const m = chipModel(r, { accounts: [...ACCOUNTS, LOCKED], defaultAccountId: 'alice' });
    expect(m.waitingFor).toBe('locked');
    expect(m.waitingLabel).toBe('รอปลดล็อก Locked');
    expect(m.locked).toBe(true);
    expect(m.enabled).toBe(false);
  });
  it('a job on an unlocked profile has no waiting label', () => {
    const r = { alive: true, busy: false, queued: 0, accountId: 'alice' } as RunnerState;
    const m = chipModel(r, { accounts: ACCOUNTS, defaultAccountId: 'alice' });
    expect(m.waitingFor).toBeNull();
    expect(m.waitingLabel).toBeNull();
    expect(m.locked).toBe(false);
  });
  it('isLockedFailure reads the raw code, the error field, or the translated text', () => {
    expect(isLockedFailure({ ok: false, code: LOCKED_CODE })).toBe(true);
    expect(isLockedFailure({ ok: false, error: LOCKED_CODE })).toBe(true);
    expect(isLockedFailure({ ok: false, error: tx(LOCKED_CODE) })).toBe(true);
    expect(isLockedFailure({ ok: false, error: 'other' })).toBe(false);
    expect(isLockedFailure({ ok: true, code: LOCKED_CODE })).toBe(false);
  });
  it('isLockedProfile is true only for a locked row', () => {
    expect(isLockedProfile([...ACCOUNTS, LOCKED], 'locked')).toBe(true);
    expect(isLockedProfile(ACCOUNTS, 'alice')).toBe(false);
    expect(isLockedProfile(ACCOUNTS, 'ghost')).toBe(false);
  });
});

describe('global usage snapshot for the main account in job lists', () => {
  const MAIN = acct({ id: TERMINAL_ACCOUNT_ID, name: 'x', builtin: true, tokenState: 'unset', fingerprint: null, letter: 'T' });
  const GLOBAL_LOW: UsageSnapshot = {
    fiveHour: null,
    sevenDay: { pct: 5, resetsAt: null, updatedAt: NOW, sessionId: null, model: null },
    sessions: [],
  };
  const GLOBAL_CAPPED: UsageSnapshot = {
    fiveHour: { pct: 100, resetsAt: NOW + 3600_000, updatedAt: NOW, sessionId: null, model: null },
    sevenDay: null,
    sessions: [],
  };

  it('ranks the main account by the global weekly % (lowest first)', () => {
    const ids = alternatives([ALICE, BOB, CAROL, MAIN], 'alice', NOW, GLOBAL_LOW).map((a) => a.id);
    expect(ids).toEqual([TERMINAL_ACCOUNT_ID, 'carol', 'bob']);
  });

  it('marks the main account limited when the global 5 h window is at the cap', () => {
    const rows = limitRows([ALICE, BOB, MAIN], 'alice', NOW, GLOBAL_CAPPED);
    const main = rows.find((r) => r.account.id === TERMINAL_ACCOUNT_ID);
    expect(main?.limited).toBe(true);
    expect(main?.badge).toEqual({ kind: 'limit' });
  });

  it('shows the main account week badge in the limit card from the global snapshot', () => {
    const main = limitRows([ALICE, MAIN], 'alice', NOW, GLOBAL_LOW).find((r) => r.account.id === TERMINAL_ACCOUNT_ID);
    expect(main?.limited).toBe(false);
    expect(main?.badge).toEqual({ kind: 'week', pct: 5 });
  });

  it('shows no badge for the main account without a global snapshot', () => {
    const main = limitRows([ALICE, MAIN], 'alice', NOW).find((r) => r.account.id === TERMINAL_ACCOUNT_ID);
    expect(main?.badge).toEqual({ kind: 'none' });
  });
});

describe('switch confirm text (no CLI jargon)', () => {
  it('uses the Thai and English sentences for a job restart', () => {
    expect(th['acct.job.switchNow']).toBe('งานจะเปิดใหม่ด้วยบัญชีนี้ (ไม่กี่วินาที) บทสนทนาอยู่ครบ');
    expect(en['acct.job.switchNow']).toBe('The job restarts on this profile (a few seconds); the conversation is kept.');
    expect(th['acct.job.switchNow']).not.toContain('--resume');
    expect(en['acct.job.switchNow']).not.toContain('--resume');
  });
});
