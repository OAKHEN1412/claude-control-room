import { afterEach, describe, expect, it } from 'vitest';
import type { AccountInfo, ConnectEvent } from '../../shared/accounts';
import { ACCOUNT_COLORS, EXPIRY_WARN_MS, TERMINAL_ACCOUNT_ID } from '../../shared/accounts';
import type { UsageSnapshot } from '../../shared/usage';
import {
  avatarOf,
  badgeOf,
  usageOfProfile,
  connectIsFinal,
  describeExpiry,
  displayLetter,
  displayName,
  errText,
  isUsable,
  maskedEmail,
  needsUnlock,
  profileById,
  reduceAccounts,
  visibleProfiles,
  weekAndFiveHour,
  type AccountsSlice,
} from './accountsView';
import { setLanguage } from './i18n';
import { th } from './i18n/th';
import { en } from './i18n/en';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;

afterEach(() => setLanguage('th', { persist: false }));

function acc(id: string, over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id, name: id, color: ACCOUNT_COLORS[2], letter: 'A', note: '', builtin: false, tokenState: 'unset', fingerprint: null,
    createdAt: 1, tokenAt: null, expiresAt: null, lastCheckAt: null, lastCheckOk: null, usage: null, hidden: false, locked: false, hasPassword: false, ...over,
  };
}

const withToken = (expiresInMs: number): Partial<AccountInfo> => ({
  tokenState: 'set', tokenAt: NOW, expiresAt: NOW + expiresInMs,
});

describe('avatarOf', () => {
  it('returns the letter and the stored colour', () => {
    expect(avatarOf(acc('a', { letter: 'WK', color: ACCOUNT_COLORS[4] }))).toEqual({ letter: 'WK', color: ACCOUNT_COLORS[4] });
  });

  it('falls back to a palette colour and "?" for an empty letter', () => {
    expect(avatarOf(acc('a', { letter: '', color: '#000000' }))).toEqual({ letter: '?', color: ACCOUNT_COLORS[0] });
  });
});

describe('visibleProfiles / profileById', () => {
  const list = [acc('terminal', { builtin: true }), acc('a'), acc('hid', { hidden: true }), acc('b')];

  it('drops hidden profiles and puts the default first', () => {
    expect(visibleProfiles(list, 'b').map((a) => a.id)).toEqual(['b', 'terminal', 'a']);
  });

  it('keeps server order when the default is the built-in one', () => {
    expect(visibleProfiles(list, 'terminal').map((a) => a.id)).toEqual(['terminal', 'a', 'b']);
  });

  it('finds a profile by id', () => {
    expect(profileById(list, 'a')?.id).toBe('a');
    expect(profileById(list, 'nope')).toBeUndefined();
  });
});

describe('isUsable / needsUnlock', () => {
  it('the built-in profile is usable without a token', () => {
    expect(isUsable(acc('terminal', { builtin: true }))).toBe(true);
  });

  it('a token profile is usable only when its token is set', () => {
    expect(isUsable(acc('a', { tokenState: 'set' }))).toBe(true);
    expect(isUsable(acc('a', { tokenState: 'unset' }))).toBe(false);
  });

  it('a locked profile is never usable, even with a token', () => {
    expect(isUsable(acc('a', { tokenState: 'set', locked: true, hasPassword: true }))).toBe(false);
    expect(isUsable(acc('terminal', { builtin: true, locked: true }))).toBe(false);
  });

  it('needsUnlock is true exactly for a locked profile', () => {
    expect(needsUnlock(acc('a', { locked: true, hasPassword: true }))).toBe(true);
    expect(needsUnlock(acc('a', { locked: false, hasPassword: true }))).toBe(false);
    expect(needsUnlock(acc('terminal', { builtin: true }))).toBe(false);
  });
});

describe('displayName', () => {
  const t = (key: string) => (key === 'acct.terminal.name' ? 'Main account' : key);

  it('names the built-in profile with the translated terminal name', () => {
    expect(displayName(acc('terminal', { builtin: true, name: 'ignored' }), t)).toBe('Main account');
  });

  it('uses the stored name for every other profile', () => {
    expect(displayName(acc('work', { name: 'Work' }), t)).toBe('Work');
  });
});

describe('maskedEmail', () => {
  it('masks the main account email', () => {
    const a = acc('terminal', { builtin: true, main: { loggedIn: true, email: 'alice@example.com', plan: null, orgName: null, expiresAt: null, checkedAt: NOW } });
    expect(maskedEmail(a)).toBe('a***@example.com');
  });

  it('is empty without main info, without an email, or for a token profile', () => {
    expect(maskedEmail(acc('terminal', { builtin: true }))).toBe('');
    expect(maskedEmail(acc('terminal', { builtin: true, main: { loggedIn: false, email: null, plan: null, orgName: null, expiresAt: null, checkedAt: NOW } }))).toBe('');
    expect(maskedEmail(acc('a'))).toBe('');
  });
});

describe('badgeOf', () => {
  it('shows limit when a window is at the cap', () => {
    const a = acc('a', { usage: { fiveHour: { pct: 99, resetsAt: NOW + 3600_000 }, sevenDay: null, updatedAt: NOW } });
    expect(badgeOf(a, NOW)).toEqual({ kind: 'limit' });
  });

  it('shows the weekly percentage rounded when not limited', () => {
    const a = acc('a', { usage: { fiveHour: null, sevenDay: { pct: 71.6, resetsAt: NOW + DAY }, updatedAt: NOW } });
    expect(badgeOf(a, NOW)).toEqual({ kind: 'week', pct: 72 });
  });

  it('shows nothing without usage', () => {
    expect(badgeOf(acc('a'), NOW)).toEqual({ kind: 'none' });
  });

  it('ignores a limit whose reset has passed', () => {
    const a = acc('a', { usage: { fiveHour: { pct: 100, resetsAt: NOW - 1 }, sevenDay: null, updatedAt: NOW } });
    expect(badgeOf(a, NOW)).toEqual({ kind: 'none' });
  });
});

describe('weekAndFiveHour', () => {
  it('rounds both windows and reports null for unknown ones', () => {
    const a = acc('a', { usage: { fiveHour: { pct: 39.4, resetsAt: null }, sevenDay: null, updatedAt: NOW } });
    expect(weekAndFiveHour(a)).toEqual({ five: 39, seven: null });
    expect(weekAndFiveHour(acc('b'))).toEqual({ five: null, seven: null });
  });
});

describe('describeExpiry', () => {
  it('is none without a token', () => {
    expect(describeExpiry(acc('a'), NOW)).toEqual({ level: 'none', days: null });
  });

  it('is ok with the days left rounded up', () => {
    expect(describeExpiry(acc('a', withToken(100 * DAY + 1)), NOW)).toEqual({ level: 'ok', days: 101 });
  });

  it('is warn inside the warning window', () => {
    expect(describeExpiry(acc('a', withToken(2 * 3600_000)), NOW)).toEqual({ level: 'warn', days: 1 });
    expect(describeExpiry(acc('a', withToken(EXPIRY_WARN_MS - 1)), NOW)).toEqual({ level: 'warn', days: 30 });
  });

  it('is expired with no day count once past', () => {
    expect(describeExpiry(acc('a', withToken(-DAY)), NOW)).toEqual({ level: 'expired', days: null });
  });
});

describe('connectIsFinal', () => {
  const ev = (status: ConnectEvent['status']): ConnectEvent => ({ accountId: 'a', status });

  it('is true only for terminal statuses', () => {
    for (const s of ['done', 'failed', 'timeout', 'cancelled'] as const) expect(connectIsFinal(ev(s))).toBe(true);
    for (const s of ['waiting_browser', 'captured', 'checking'] as const) expect(connectIsFinal(ev(s))).toBe(false);
  });
});

describe('reduceAccounts', () => {
  const base: AccountsSlice = { accounts: [acc('terminal', { builtin: true })], defaultAccountId: 'terminal', ptyAvailable: false, connect: null };

  it('accounts message replaces the three fields', () => {
    const s = reduceAccounts(base, { type: 'accounts', serverTime: 1, accounts: [acc('x')], defaultId: 'x', ptyAvailable: true });
    expect(s).toEqual({ accounts: [acc('x')], defaultAccountId: 'x', ptyAvailable: true, connect: null });
  });

  it('account_connect stores the event', () => {
    const e: ConnectEvent = { accountId: 'x', status: 'captured' };
    expect(reduceAccounts(base, { type: 'account_connect', serverTime: 1, event: e }).connect).toEqual(e);
  });

  it('snapshot keeps fields it does not carry', () => {
    const s = reduceAccounts(base, { type: 'snapshot', machine: 'm', serverTime: 1, sessions: [], defaultAccountId: 'x' } as never);
    expect(s.accounts).toBe(base.accounts);
    expect(s.defaultAccountId).toBe('x');
    expect(s.ptyAvailable).toBe(false);
  });

  it('other messages leave the four fields as they were', () => {
    expect(reduceAccounts(base, { type: 'ping', serverTime: 1 } as never)).toEqual(base);
  });
});

describe('errText', () => {
  it('gives the Thai text by default and the English text after a switch', () => {
    expect(errText('NOT_FOUND')).toBe(th['acct.err.NOT_FOUND']);
    setLanguage('en', { persist: false });
    expect(errText('NOT_FOUND')).toBe(en['acct.err.NOT_FOUND']);
  });

  it('falls back to the generic server error for an unknown code', () => {
    expect(errText('SOMETHING_NEW')).toBe(th['acct.err.SERVER_ERROR']);
  });

  it('returns an already-translated message unchanged', () => {
    const msg = 'ไม่พบบัญชีที่เลือก';
    expect(errText(msg)).toBe(msg);
    expect(errText('Account not found')).toBe('Account not found');
  });

  it('keeps the generic fallback for srv.* codes', () => {
    expect(errText('srv.unknown.code')).toBe(th['acct.err.SERVER_ERROR']);
  });
});

describe('displayLetter', () => {
  const mainWith = (email: string | null) => ({ loggedIn: true, email, plan: null, orgName: null, expiresAt: null, checkedAt: NOW });

  it('shows the first letter of the main account email local part', () => {
    setLanguage('th', { persist: false });
    expect(displayLetter({ letter: 'T', builtin: true, main: mainWith('alice@example.com') })).toBe('A');
  });

  it('skips leading symbols and upper-cases a digit or a Thai letter', () => {
    expect(displayLetter({ letter: 'T', builtin: true, main: mainWith('.bob@example.com') })).toBe('B');
    expect(displayLetter({ letter: 'T', builtin: true, main: mainWith('7up@example.com') })).toBe('7');
    expect(displayLetter({ letter: 'T', builtin: true, main: mainWith('สมชาย@example.com') })).toBe('ส');
  });

  it('falls back to ห in Thai and M in English when there is no email', () => {
    setLanguage('th', { persist: false });
    expect(displayLetter({ letter: 'T', builtin: true })).toBe('ห');
    expect(displayLetter({ letter: 'T', builtin: true, main: mainWith(null) })).toBe('ห');
    setLanguage('en', { persist: false });
    expect(displayLetter({ letter: 'T', builtin: true, main: mainWith(null) })).toBe('M');
  });

  it('keeps the stored letter for a token profile', () => {
    expect(displayLetter({ letter: 'WK', builtin: false, main: mainWith('alice@example.com') })).toBe('WK');
    expect(displayLetter({ letter: 'WK' })).toBe('WK');
  });

  it('avatarOf uses the same letter for the built-in profile', () => {
    expect(avatarOf(acc('terminal', { letter: 'T', builtin: true, main: mainWith('alice@example.com') })).letter).toBe('A');
  });
});

describe('usageOfProfile', () => {
  const GLOBAL_SNAP: UsageSnapshot = {
    fiveHour: { pct: 35.2, resetsAt: NOW + 3 * 3600_000, updatedAt: NOW - 60_000, sessionId: null, model: null },
    sevenDay: { pct: 73.4, resetsAt: NOW + DAY, updatedAt: NOW - 120_000, sessionId: null, model: null },
    sessions: [],
  };
  const main = acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', name: 'Terminal login' });

  it('maps the global snapshot onto the built-in main account (both windows, newest updatedAt)', () => {
    expect(usageOfProfile(main, GLOBAL_SNAP)).toEqual({
      fiveHour: { pct: 35.2, resetsAt: NOW + 3 * 3600_000 },
      sevenDay: { pct: 73.4, resetsAt: NOW + DAY },
      updatedAt: NOW - 60_000,
    });
  });

  it('also maps a builtin profile that is not the Terminal id', () => {
    expect(usageOfProfile(acc('other', { builtin: true }), GLOBAL_SNAP)?.sevenDay?.pct).toBe(73.4);
  });

  it('gives null for the built-in profile without a global snapshot or without any quota', () => {
    expect(usageOfProfile(main)).toBeNull();
    expect(usageOfProfile(main, { fiveHour: null, sevenDay: null, sessions: [] })).toBeNull();
  });

  it('keeps a window the snapshot lacks as null', () => {
    const only7 = { ...GLOBAL_SNAP, fiveHour: null };
    expect(usageOfProfile(main, only7)?.fiveHour).toBeNull();
    expect(usageOfProfile(main, only7)?.sevenDay?.pct).toBe(73.4);
  });

  it('reads a token profile from its own usage and ignores the global snapshot', () => {
    const own = { fiveHour: null, sevenDay: { pct: 12, resetsAt: null }, updatedAt: NOW };
    const work = acc('work', { tokenState: 'set', usage: own });
    expect(usageOfProfile(work, GLOBAL_SNAP)).toBe(own);
    expect(usageOfProfile(acc('bare', { tokenState: 'set' }), GLOBAL_SNAP)).toBeNull();
  });
});

describe('badgeOf / weekAndFiveHour with the global snapshot', () => {
  const GLOBAL_SNAP: UsageSnapshot = {
    fiveHour: { pct: 35.2, resetsAt: NOW + 3600_000, updatedAt: NOW, sessionId: null, model: null },
    sevenDay: { pct: 73.4, resetsAt: NOW + DAY, updatedAt: NOW, sessionId: null, model: null },
    sessions: [],
  };
  const main = acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset' });

  it('the main account shows its week % badge and bars from the global snapshot', () => {
    expect(badgeOf(main, NOW, GLOBAL_SNAP)).toEqual({ kind: 'week', pct: 73 });
    expect(weekAndFiveHour(main, GLOBAL_SNAP)).toEqual({ five: 35, seven: 73 });
  });

  it('the main account is limited when the global 5 h window is at the cap', () => {
    const capped: UsageSnapshot = { ...GLOBAL_SNAP, fiveHour: { ...GLOBAL_SNAP.fiveHour!, pct: 100 } };
    expect(badgeOf(main, NOW, capped)).toEqual({ kind: 'limit' });
  });

  it('without a global snapshot the main account has no badge and null bars', () => {
    expect(badgeOf(main, NOW)).toEqual({ kind: 'none' });
    expect(weekAndFiveHour(main)).toEqual({ five: null, seven: null });
  });
});
