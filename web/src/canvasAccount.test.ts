import { describe, expect, it } from 'vitest';
import { TERMINAL_ACCOUNT_ID, type AccountInfo } from '../../shared/accounts';
import type { RunnerState } from '../../shared/protocol';
import { displayLetter } from './accountsView';
import { cardAvatar, cardWaiting, popoverRow, showCardAvatar } from './canvasAccount';

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
    locked: false,
    hasPassword: false,
    ...over,
  };
}

const ACCOUNTS: AccountInfo[] = [
  acct({ id: TERMINAL_ACCOUNT_ID, name: 'Terminal', builtin: true, tokenState: 'unset', fingerprint: null, letter: 'T' }),
  acct({ id: 'alice', name: 'Alice' }),
  acct({ id: 'bob', name: 'Bob', tokenState: 'unset', fingerprint: null }),
  acct({ id: 'carol', name: 'Carol', locked: true }),
  acct({ id: 'hidden1', name: 'Hidden', hidden: true }),
];
const snap = { accounts: ACCOUNTS, defaultAccountId: 'alice' };

function runner(over: Partial<RunnerState> = {}): RunnerState {
  return { alive: true, busy: false, queued: 0, accountId: 'alice', ...over } as RunnerState;
}

describe('showCardAvatar', () => {
  it('shows for a live local job only', () => {
    expect(showCardAvatar(runner())).toBe(true);
    expect(showCardAvatar(runner({ alive: false }))).toBe(false);
    expect(showCardAvatar(runner({ machineId: 'm1' }))).toBe(false);
    expect(showCardAvatar(undefined)).toBe(false);
  });
});

describe('cardAvatar / cardWaiting', () => {
  it('uses the profile name for a normal job and the Terminal label for the Terminal profile', () => {
    expect(cardAvatar(runner(), snap)).toEqual({ name: 'Alice', letter: 'A', color: '#6366f1', builtin: false });
    const term = cardAvatar(runner({ accountId: TERMINAL_ACCOUNT_ID }), snap);
    expect(term?.letter).toBe(displayLetter({ letter: '', builtin: true }));
    expect(term?.builtin).toBe(true);
    expect(term?.name.length).toBeGreaterThan(0);
    expect(term?.name).not.toBe(TERMINAL_ACCOUNT_ID);
  });

  it('is null for remote or dead jobs', () => {
    expect(cardAvatar(runner({ machineId: 'm1' }), snap)).toBeNull();
    expect(cardAvatar(runner({ alive: false }), snap)).toBeNull();
  });

  it('gives the waiting label for a job waiting for a locked profile', () => {
    expect(cardWaiting(runner({ waitingUnlock: 'carol' } as Partial<RunnerState>), snap)).toContain('Carol');
    expect(cardWaiting(runner(), snap)).toBeNull();
    expect(cardWaiting(runner({ machineId: 'm1', waitingUnlock: 'carol' } as Partial<RunnerState>), snap)).toBeNull();
  });
});

describe('popoverRow', () => {
  it('is hidden for remote jobs and when there is no runner', () => {
    expect(popoverRow(undefined, snap).visible).toBe(false);
    expect(popoverRow(runner({ machineId: 'm1' }), snap).visible).toBe(false);
  });

  it('lists usable visible profiles with the current one ticked', () => {
    const row = popoverRow(runner(), snap);
    expect(row.visible).toBe(true);
    expect(row.value).toBe('alice');
    const ids = row.options.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining([TERMINAL_ACCOUNT_ID, 'alice', 'carol']));
    expect(ids).not.toContain('bob');
    expect(ids).not.toContain('hidden1');
    expect(row.options.find((o) => o.id === 'carol')?.locked).toBe(true);
    expect(row.disabled).toBe(false);
    expect(row.reasonKey).toBeNull();
  });

  it('keeps the current profile even when it has no token', () => {
    const row = popoverRow(runner({ accountId: 'bob' }), snap);
    expect(row.value).toBe('bob');
    expect(row.options.map((o) => o.id)).toContain('bob');
  });

  it('is disabled with a reason when the job is not alive', () => {
    const row = popoverRow(runner({ alive: false }), snap);
    expect(row.visible).toBe(true);
    expect(row.disabled).toBe(true);
    expect(row.reasonKey).toBe('acct.job.notAlive');
  });
});
