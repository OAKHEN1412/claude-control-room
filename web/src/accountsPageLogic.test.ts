import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/accounts';
import type { UsageSnapshot } from '../../shared/usage';
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID } from '../../shared/accounts';
import {
  ARM_IDLE,
  DELETE_ARM_MS,
  DELETE_IDLE,
  MAIN_ARM_MS,
  armExpire,
  armPress,
  mainErrorKey,
  mainExpiry,
  mainExpiryView,
  barWidth,
  buildRows,
  checkName,
  checkNote,
  deleteReducer,
  expiryClass,
  isArmed,
  relTimeText,
  sortAccounts,
  type DeleteState,
} from './accountsPageLogic';

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;

function acc(id: string, over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id,
    name: id,
    color: ACCOUNT_COLORS[0],
    letter: 'A',
    note: '',
    builtin: false,
    tokenState: 'set',
    fingerprint: 'abcd1234',
    createdAt: 100,
    tokenAt: 100,
    expiresAt: NOW + 200 * DAY,
    lastCheckAt: null,
    lastCheckOk: null,
    usage: null,
    hidden: false,
    locked: false, hasPassword: false,
    ...over,
  };
}

describe('sortAccounts', () => {
  it('puts the builtin first, then by createdAt', () => {
    const list = [
      acc('late', { createdAt: 300 }),
      acc('early', { createdAt: 100 }),
      acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', createdAt: 999 }),
    ];
    expect(sortAccounts(list).map((a) => a.id)).toEqual([TERMINAL_ACCOUNT_ID, 'early', 'late']);
  });

  it('does not mutate its input and is stable on equal createdAt', () => {
    const list = [acc('b', { createdAt: 5 }), acc('a', { createdAt: 5 })];
    expect(sortAccounts(list).map((a) => a.id)).toEqual(['a', 'b']);
    expect(list.map((a) => a.id)).toEqual(['b', 'a']);
  });
});

describe('buildRows', () => {
  it('builds the view model for a connected profile', () => {
    const rows = buildRows(
      [
        acc('x', {
          usage: {
            fiveHour: { pct: 42.4, resetsAt: null },
            sevenDay: { pct: 87.6, resetsAt: null },
            updatedAt: NOW,
          },
          lastCheckAt: NOW - 60_000,
          lastCheckOk: true,
        }),
      ],
      'x',
      NOW,
    );
    const r = rows[0];
    expect(r.isDefault).toBe(true);
    expect(r.needsConnect).toBe(false);
    expect(r.tokenSet).toBe(true);
    expect(r.fingerprint).toBe('abcd·1234');
    expect(r.expiry.level).toBe('ok');
    expect(r.expiryKey).toBe('acct.expiry.ok');
    expect(r.expiryVars).toEqual({ days: 200 });
    expect(r.check).toBe('ok');
    expect(r.fivePct).toBe(42);
    expect(r.weekPct).toBe(88);
    expect(r.weekBar).toBe(88);
  });

  it('marks an unconnected non-builtin profile as needing connect, with no expiry or fingerprint', () => {
    const [r] = buildRows([acc('u', { tokenState: 'unset', fingerprint: null, expiresAt: null })], 'terminal', NOW);
    expect(r.needsConnect).toBe(true);
    expect(r.fingerprint).toBe('—');
    expect(r.expiryKey).toBeNull();
    expect(r.check).toBe('never');
  });

  it('never flags the builtin row as needing connect and shows unknown usage as null', () => {
    const [r] = buildRows(
      [acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', fingerprint: null, expiresAt: null })],
      TERMINAL_ACCOUNT_ID,
      NOW,
    );
    expect(r.builtin).toBe(true);
    expect(r.needsConnect).toBe(false);
    expect(r.fivePct).toBeNull();
    expect(r.weekBar).toBe(0);
    expect(r.isDefault).toBe(true);
  });

  it('maps a failed last check and a warn expiry', () => {
    const [r] = buildRows([acc('w', { lastCheckOk: false, lastCheckAt: NOW, expiresAt: NOW + 5 * DAY })], '', NOW);
    expect(r.check).toBe('fail');
    expect(r.expiry.level).toBe('warn');
    expect(r.expiryClass).toBe('ap-exp-warn');
    expect(r.isDefault).toBe(false);
  });

  it('maps an expired token to the expired class and no day count', () => {
    const [r] = buildRows([acc('e', { expiresAt: NOW - DAY })], '', NOW);
    expect(r.expiry.level).toBe('expired');
    expect(r.expiryClass).toBe('ap-exp-expired');
    expect(r.expiryVars).toBeUndefined();
  });
});

describe('expiryClass', () => {
  it('maps every level to a class', () => {
    expect(expiryClass('ok')).toBe('ap-exp-none');
    expect(expiryClass('none')).toBe('ap-exp-none');
    expect(expiryClass('warn')).toBe('ap-exp-warn');
    expect(expiryClass('expired')).toBe('ap-exp-expired');
  });
});

describe('barWidth', () => {
  it('clamps to 0..100 and treats unknown as 0', () => {
    expect(barWidth(50)).toBe(50);
    expect(barWidth(-3)).toBe(0);
    expect(barWidth(120)).toBe(100);
    expect(barWidth(null)).toBe(0);
    expect(barWidth(undefined)).toBe(0);
    expect(barWidth(Number.NaN)).toBe(0);
  });
});

describe('checkName / checkNote', () => {
  it('trims and collapses the name', () => {
    expect(checkName('  Work   account ')).toEqual({ ok: true, value: 'Work account' });
  });

  it('rejects an empty or too long name', () => {
    expect(checkName('   ')).toEqual({ ok: false, error: 'NAME_INVALID' });
    expect(checkName('x'.repeat(41))).toEqual({ ok: false, error: 'NAME_INVALID' });
  });

  it('accepts an empty note and trims it', () => {
    expect(checkNote('   ')).toEqual({ ok: true, value: '' });
    expect(checkNote(' hi ')).toEqual({ ok: true, value: 'hi' });
  });

  it('accepts a note of exactly 80 characters and rejects 81', () => {
    expect(checkNote('a'.repeat(80))).toEqual({ ok: true, value: 'a'.repeat(80) });
    expect(checkNote('a'.repeat(81))).toEqual({ ok: false, error: 'NOTE_INVALID' });
  });
});

describe('delete state machine', () => {
  it('idle -> armed -> deleted on two presses of the same row', () => {
    const first = deleteReducer(DELETE_IDLE, { type: 'press', id: 'a', now: NOW });
    expect(first.action).toBe('arm');
    expect(isArmed(first.state, 'a', NOW)).toBe(true);
    const second = deleteReducer(first.state, { type: 'press', id: 'a', now: NOW + 1000 });
    expect(second.action).toBe('confirm');
    expect(second.state).toEqual({ phase: 'deleted', id: 'a' });
    expect(deleteReducer(second.state, { type: 'reset' }).state).toEqual(DELETE_IDLE);
  });

  it('a press on another row disarms the first and arms the second', () => {
    const a = deleteReducer(DELETE_IDLE, { type: 'press', id: 'a', now: NOW }).state;
    const b = deleteReducer(a, { type: 'press', id: 'b', now: NOW + 10 });
    expect(b.action).toBe('arm');
    expect(isArmed(b.state, 'a', NOW + 10)).toBe(false);
    expect(isArmed(b.state, 'b', NOW + 10)).toBe(true);
  });

  it('reverts to idle after the arm window', () => {
    const armed: DeleteState = deleteReducer(DELETE_IDLE, { type: 'press', id: 'a', now: NOW }).state;
    expect(deleteReducer(armed, { type: 'tick', now: NOW + DELETE_ARM_MS - 1 }).state).toBe(armed);
    expect(deleteReducer(armed, { type: 'tick', now: NOW + DELETE_ARM_MS }).state).toEqual(DELETE_IDLE);
    expect(isArmed(armed, 'a', NOW + DELETE_ARM_MS)).toBe(false);
  });

  it('cancel (Esc / blur) returns an armed row to idle but never interrupts a confirmed delete', () => {
    const armed = deleteReducer(DELETE_IDLE, { type: 'press', id: 'a', now: NOW }).state;
    expect(deleteReducer(armed, { type: 'cancel' }).state).toEqual(DELETE_IDLE);
    const deleted: DeleteState = { phase: 'deleted', id: 'a' };
    expect(deleteReducer(deleted, { type: 'cancel' }).state).toBe(deleted);
  });

  it('ignores a press while a delete is in flight', () => {
    const deleted: DeleteState = { phase: 'deleted', id: 'a' };
    expect(deleteReducer(deleted, { type: 'press', id: 'a', now: NOW })).toEqual({ state: deleted, action: 'none' });
  });
});

describe('relTimeText', () => {
  it('reuses the shared formatAge text in Thai', () => {
    expect(relTimeText(NOW - 5 * 60_000, NOW, 'th')).toBe('5 นาทีที่แล้ว');
  });

  it('writes English relative times', () => {
    expect(relTimeText(NOW - 20_000, NOW, 'en')).toBe('20 sec ago');
    expect(relTimeText(NOW - 5 * 60_000, NOW, 'en')).toBe('5 min ago');
    expect(relTimeText(NOW - 3 * 3600_000, NOW, 'en')).toBe('3 h ago');
    expect(relTimeText(NOW - 2 * DAY, NOW, 'en')).toBe('2 d ago');
  });

  it('never shows a negative age for a timestamp in the future', () => {
    expect(relTimeText(NOW + 5000, NOW, 'en')).toBe('0 sec ago');
  });
});

describe('two-click main account arm', () => {
  it('first press arms, second press confirms and returns to idle', () => {
    const first = armPress(ARM_IDLE, NOW);
    expect(first.action).toBe('arm');
    expect(first.state).toEqual({ armed: true, since: NOW });
    const second = armPress(first.state, NOW + 1000);
    expect(second.action).toBe('confirm');
    expect(second.state).toEqual(ARM_IDLE);
  });

  it('reverts after MAIN_ARM_MS without a second press', () => {
    const s = armPress(ARM_IDLE, NOW).state;
    expect(armExpire(s, NOW + MAIN_ARM_MS - 1)).toEqual(s);
    expect(armExpire(s, NOW + MAIN_ARM_MS)).toEqual(ARM_IDLE);
  });

  it('a press after the window is a new first press, not a confirm', () => {
    const s = armPress(ARM_IDLE, NOW).state;
    const late = armExpire(s, NOW + MAIN_ARM_MS);
    expect(armPress(late, NOW + MAIN_ARM_MS + 1).action).toBe('arm');
  });
});

describe('main account expiry and errors', () => {
  it('describes the login expiry with the token expiry levels', () => {
    expect(mainExpiry(null, NOW)).toMatchObject({ level: 'none', key: null, vars: undefined });
    expect(mainExpiry(NOW + 10 * DAY, NOW)).toMatchObject({ level: 'warn', key: 'acct.expiry.warn', vars: { days: 10 }, cls: 'ap-exp-warn' });
    expect(mainExpiry(NOW + 200 * DAY, NOW)).toMatchObject({ level: 'ok', days: 200 });
    expect(mainExpiry(NOW - DAY, NOW)).toMatchObject({ level: 'expired', key: 'acct.expiry.expired', days: null });
  });

  it('maps BUSY_JOBS to its own key and leaves other codes to errText', () => {
    expect(mainErrorKey('BUSY_JOBS')).toBe('acct.mng.main.err.BUSY_JOBS');
    expect(mainErrorKey('LOGIN_BUSY')).toBeNull();
  });
});

describe('mainExpiryView', () => {
  it('is none without an expiry', () => {
    expect(mainExpiryView(null, NOW)).toEqual({ kind: 'none', days: null, date: null });
  });

  it('29 days left is auto: the login renews by itself', () => {
    const v = mainExpiryView(NOW + 29 * DAY, NOW);
    expect(v).toMatchObject({ kind: 'auto', days: 29 });
    expect(v.date).toEqual(expect.any(String));
  });

  it('exactly 3 days left is still auto, under 3 days is warn', () => {
    expect(mainExpiryView(NOW + 3 * DAY, NOW)).toMatchObject({ kind: 'auto' });
    expect(mainExpiryView(NOW + 2 * DAY, NOW)).toMatchObject({ kind: 'warn', days: 2 });
  });

  it('past the expiry is expired', () => {
    expect(mainExpiryView(NOW - DAY, NOW)).toMatchObject({ kind: 'expired', days: -1 });
  });
});

describe('buildRows with the global usage snapshot', () => {
  it('fills the main account bars from the global snapshot', () => {
    const main = acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset' });
    const snap: UsageSnapshot = {
      fiveHour: { pct: 35.2, resetsAt: null, updatedAt: NOW, sessionId: null, model: null },
      sevenDay: { pct: 73.4, resetsAt: null, updatedAt: NOW, sessionId: null, model: null },
      sessions: [],
    };
    const row = buildRows([main], TERMINAL_ACCOUNT_ID, NOW, snap)[0]!;
    expect(row.fivePct).toBe(35);
    expect(row.weekPct).toBe(73);
    expect(row.weekBar).toBe(73);
    expect(buildRows([main], TERMINAL_ACCOUNT_ID, NOW)[0]!.weekPct).toBeNull();
  });
});
