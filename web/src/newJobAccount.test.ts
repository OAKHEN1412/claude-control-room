import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/accounts';
import { TERMINAL_ACCOUNT_ID, TOKEN_LIFETIME_MS } from '../../shared/accounts';
import { accountIdToSend, accountOptions, resolveAccountSelection, showAccountSelect, type AccountOption } from './newJobAccount';

const NOW = 1_800_000_000_000;
const NAMES = { terminal: 'ล็อกอินเทอร์มินัล', limit: 'ติด limit' };

function acct(over: Partial<AccountInfo> & { id: string }): AccountInfo {
  return {
    name: over.id,
    color: '#ef4444',
    letter: 'A',
    note: '',
    builtin: false,
    tokenState: 'set',
    fingerprint: 'abcd1234',
    createdAt: 1,
    tokenAt: NOW - 1000,
    expiresAt: NOW - 1000 + TOKEN_LIFETIME_MS,
    lastCheckAt: null,
    lastCheckOk: null,
    usage: null,
    hidden: false,
    locked: false, hasPassword: false,
    ...over,
  };
}

const terminal = acct({ id: TERMINAL_ACCOUNT_ID, name: 'Terminal', builtin: true, tokenState: 'unset', fingerprint: null, tokenAt: null, expiresAt: null, createdAt: 0 });

describe('accountOptions', () => {
  it('lists the terminal profile by its localised name and puts the default first', () => {
    const opts = accountOptions([terminal, acct({ id: 'work', name: 'Work' })], 'work', NOW, NAMES);
    expect(opts).toEqual([
      { id: 'work', label: 'Work' },
      { id: TERMINAL_ACCOUNT_ID, label: NAMES.terminal },
    ]);
  });

  it('appends the limit word to a profile at its limit', () => {
    const limited = acct({ id: 'x', name: 'X', usage: { fiveHour: { pct: 100, resetsAt: NOW + 60_000 }, sevenDay: null, updatedAt: NOW } });
    expect(accountOptions([terminal, limited], TERMINAL_ACCOUNT_ID, NOW, NAMES)[1].label).toBe('X · ติด limit');
  });

  it('leaves out hidden profiles and non-builtin profiles without a token', () => {
    const opts = accountOptions(
      [terminal, acct({ id: 'h', hidden: true }), acct({ id: 'nt', tokenState: 'unset', fingerprint: null })],
      TERMINAL_ACCOUNT_ID,
      NOW,
      NAMES,
    );
    expect(opts.map((o) => o.id)).toEqual([TERMINAL_ACCOUNT_ID]);
  });

  it('returns nothing when there are no accounts', () => {
    expect(accountOptions([], 'terminal', NOW, NAMES)).toEqual([]);
  });
});

describe('resolveAccountSelection', () => {
  const opts: AccountOption[] = [
    { id: 'a', label: 'A' },
    { id: 'terminal', label: 'T' },
  ];
  it('keeps the pick while it is offered', () => expect(resolveAccountSelection(opts, 'terminal', 'a')).toBe('terminal'));
  it('falls back to the default, then the first option', () => {
    expect(resolveAccountSelection(opts, '', 'a')).toBe('a');
    expect(resolveAccountSelection(opts, 'gone', 'gone')).toBe('a');
    expect(resolveAccountSelection([], '', 'x')).toBe('');
  });
});

describe('showAccountSelect', () => {
  const two: AccountOption[] = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  it('hides for one option, for a remote target, and when empty', () => {
    expect(showAccountSelect(two, false)).toBe(true);
    expect(showAccountSelect(two.slice(0, 1), false)).toBe(false);
    expect(showAccountSelect(two, true)).toBe(false);
    expect(showAccountSelect([], false)).toBe(false);
  });
});

describe('accountIdToSend', () => {
  it('sends nothing when the user did not pick (or picked the default)', () => {
    expect(accountIdToSend('', 'a', false)).toBeUndefined();
    expect(accountIdToSend('a', 'a', false)).toBeUndefined();
  });
  it('sends a pick that differs from the default on this PC', () => {
    expect(accountIdToSend('b', 'a', false)).toBe('b');
  });
  it('never sends for a remote-machine target', () => {
    expect(accountIdToSend('b', 'a', true)).toBeUndefined();
  });
});
