// shouldRefresh: the decision behind the header's once-per-profile usage refresh (pure, node env).
import { describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID, type AccountInfo } from '../../shared/accounts';
import { shouldRefresh } from './accountsView';

function acct(id: string, over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id,
    name: id,
    color: ACCOUNT_COLORS[0],
    letter: 'A',
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

describe('shouldRefresh', () => {
  it('asks once for a profile with a token', () => {
    expect(shouldRefresh(acct('work'), null)).toBe(true);
    expect(shouldRefresh(acct('work'), 'home')).toBe(true);
  });
  it('does not ask again for the id it already asked for', () => {
    expect(shouldRefresh(acct('work'), 'work')).toBe(false);
  });
  it('never asks for Terminal, built-in or token-less profiles', () => {
    expect(shouldRefresh(acct(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset' }), null)).toBe(false);
    expect(shouldRefresh(acct('x', { builtin: true }), null)).toBe(false);
    expect(shouldRefresh(acct('work', { tokenState: 'unset' }), null)).toBe(false);
  });
  it('no profile means nothing to ask for', () => {
    expect(shouldRefresh(undefined, null)).toBe(false);
    expect(shouldRefresh(null, null)).toBe(false);
  });
});
