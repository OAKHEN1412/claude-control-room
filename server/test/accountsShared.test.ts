import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_COLORS,
  ACCOUNT_ID_RE,
  EXPIRY_WARN_MS,
  LOGIN_CODE_MAX,
  RESERVED_ACCOUNT_IDS,
  TOKEN_LIFETIME_MS,
  defaultLetter,
  expiryLeftMs,
  expiryLevel,
  formatFingerprint,
  isLimited,
  maskEmail,
  validateLoginCode,
  PIN_RE,
  validatePassword,
  validatePin,
  validateProfileInput,
  type AccountInfo,
  type AccountUsage,
} from '../../shared/accounts';

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

function withExpiry(expiresAt: number | null): Pick<AccountInfo, 'expiresAt'> {
  return { expiresAt };
}

function withUsage(usage: AccountUsage | null): Pick<AccountInfo, 'usage'> {
  return { usage };
}

describe('formatFingerprint', () => {
  it('splits 8 hex chars into two groups of 4 with a middle dot', () => {
    expect(formatFingerprint('abcd1234')).toBe('abcd·1234');
  });

  it('only uses the first 8 chars of a longer fingerprint', () => {
    expect(formatFingerprint('abcd1234ffff')).toBe('abcd·1234');
  });

  it('returns empty string for null, undefined, empty and short values', () => {
    expect(formatFingerprint(null)).toBe('');
    expect(formatFingerprint(undefined)).toBe('');
    expect(formatFingerprint('')).toBe('');
    expect(formatFingerprint('abcd123')).toBe('');
  });
});

describe('expiryLeftMs', () => {
  it('returns null without a token', () => {
    expect(expiryLeftMs(withExpiry(null), NOW)).toBeNull();
  });

  it('returns the remaining ms, negative when expired', () => {
    expect(expiryLeftMs(withExpiry(NOW + 5000), NOW)).toBe(5000);
    expect(expiryLeftMs(withExpiry(NOW - 5000), NOW)).toBe(-5000);
  });
});

describe('expiryLevel', () => {
  it('is none without a token', () => {
    expect(expiryLevel(withExpiry(null), NOW)).toBe('none');
  });

  it('is expired when the expiry is in the past', () => {
    expect(expiryLevel(withExpiry(NOW - 1), NOW)).toBe('expired');
    expect(expiryLevel(withExpiry(NOW - DAY), NOW)).toBe('expired');
  });

  it('is warn at exactly now (0 ms left is not yet expired)', () => {
    expect(expiryLevel(withExpiry(NOW), NOW)).toBe('warn');
  });

  it('is warn when less than 30 days are left', () => {
    expect(expiryLevel(withExpiry(NOW + 1), NOW)).toBe('warn');
    expect(expiryLevel(withExpiry(NOW + EXPIRY_WARN_MS - 1), NOW)).toBe('warn');
  });

  it('is ok at exactly 30 days and more', () => {
    expect(expiryLevel(withExpiry(NOW + EXPIRY_WARN_MS), NOW)).toBe('ok');
    expect(expiryLevel(withExpiry(NOW + TOKEN_LIFETIME_MS), NOW)).toBe('ok');
  });
});

describe('validateProfileInput', () => {
  it('requires a name for a full (non-partial) input', () => {
    expect(validateProfileInput({}, false)).toEqual({ ok: false, error: 'NAME_INVALID' });
    expect(validateProfileInput({ name: 5 }, false)).toEqual({ ok: false, error: 'NAME_INVALID' });
  });

  it('trims the name and collapses inner whitespace', () => {
    const r = validateProfileInput({ name: '   Team   A  \t B  ' }, false);
    expect(r).toEqual({ ok: true, value: { name: 'Team A B' } });
  });

  it('accepts a 40-char name and rejects a 41-char name', () => {
    const forty = 'a'.repeat(40);
    expect(validateProfileInput({ name: forty }, false)).toEqual({ ok: true, value: { name: forty } });
    expect(validateProfileInput({ name: 'a'.repeat(41) }, false)).toEqual({ ok: false, error: 'NAME_INVALID' });
  });

  it('rejects a name that is only whitespace', () => {
    expect(validateProfileInput({ name: '   ' }, false)).toEqual({ ok: false, error: 'NAME_INVALID' });
  });

  it('counts a name with extra spaces by its collapsed length', () => {
    const padded = `  ${'a'.repeat(39)}   b  `; // collapses to 39 + 1 space + 1 = 41 chars
    expect(validateProfileInput({ name: padded }, false)).toEqual({ ok: false, error: 'NAME_INVALID' });
  });

  it('accepts each palette colour and rejects anything else', () => {
    for (const c of ACCOUNT_COLORS) {
      expect(validateProfileInput({ name: 'x', color: c }, false)).toEqual({ ok: true, value: { name: 'x', color: c } });
    }
    expect(validateProfileInput({ name: 'x', color: '#000000' }, false)).toEqual({ ok: false, error: 'COLOR_INVALID' });
    expect(validateProfileInput({ name: 'x', color: 'red' }, false)).toEqual({ ok: false, error: 'COLOR_INVALID' });
    expect(validateProfileInput({ name: 'x', color: 7 }, false)).toEqual({ ok: false, error: 'COLOR_INVALID' });
  });

  it('rejects letter "" and letter "abc"', () => {
    expect(validateProfileInput({ name: 'x', letter: '' }, false)).toEqual({ ok: false, error: 'LETTER_INVALID' });
    expect(validateProfileInput({ name: 'x', letter: 'abc' }, false)).toEqual({ ok: false, error: 'LETTER_INVALID' });
    expect(validateProfileInput({ name: 'x', letter: '   ' }, false)).toEqual({ ok: false, error: 'LETTER_INVALID' });
  });

  it('trims and upper-cases a letter of 1..2 chars', () => {
    expect(validateProfileInput({ name: 'x', letter: ' ab ' }, false)).toEqual({ ok: true, value: { name: 'x', letter: 'AB' } });
    expect(validateProfileInput({ name: 'x', letter: 'k' }, false)).toEqual({ ok: true, value: { name: 'x', letter: 'K' } });
  });

  it('accepts a note of 80 chars and rejects 81', () => {
    expect(validateProfileInput({ name: 'x', note: 'n'.repeat(80) }, false)).toEqual({ ok: true, value: { name: 'x', note: 'n'.repeat(80) } });
    expect(validateProfileInput({ name: 'x', note: 'n'.repeat(81) }, false)).toEqual({ ok: false, error: 'NOTE_INVALID' });
  });

  it('trims the note and allows an empty note', () => {
    expect(validateProfileInput({ name: 'x', note: '  hi  ' }, false)).toEqual({ ok: true, value: { name: 'x', note: 'hi' } });
    expect(validateProfileInput({ name: 'x', note: '' }, false)).toEqual({ ok: true, value: { name: 'x', note: '' } });
  });

  it('rejects a non-string note', () => {
    expect(validateProfileInput({ name: 'x', note: 1 }, false)).toEqual({ ok: false, error: 'NOTE_INVALID' });
  });

  it('partial=true validates only the given fields, so only a note is enough', () => {
    expect(validateProfileInput({ note: '  only note ' }, true)).toEqual({ ok: true, value: { note: 'only note' } });
  });

  it('partial=true still rejects a bad given field', () => {
    expect(validateProfileInput({ name: '' }, true)).toEqual({ ok: false, error: 'NAME_INVALID' });
    expect(validateProfileInput({ letter: 'xyz' }, true)).toEqual({ ok: false, error: 'LETTER_INVALID' });
  });

  it('partial=true with an empty object is ok and empty', () => {
    expect(validateProfileInput({}, true)).toEqual({ ok: true, value: {} });
  });

  it('ignores unknown fields', () => {
    expect(validateProfileInput({ name: 'x', hidden: true, token: 'secret', id: 'evil' }, false)).toEqual({ ok: true, value: { name: 'x' } });
  });

  it('rejects non-object input', () => {
    expect(validateProfileInput(null, false).ok).toBe(false);
    expect(validateProfileInput('name', true).ok).toBe(false);
    expect(validateProfileInput([], false).ok).toBe(false);
  });
});

describe('defaultLetter', () => {
  it('takes the first letter of the first two words, upper-cased', () => {
    expect(defaultLetter('hello world')).toBe('HW');
    expect(defaultLetter('  hello world')).toBe('HW');
  });

  it('uses only the first two words', () => {
    expect(defaultLetter('alpha beta gamma')).toBe('AB');
  });

  it('uses one letter for a single word', () => {
    expect(defaultLetter('team')).toBe('T');
  });

  it('returns the first Thai letter of a Thai name', () => {
    expect(defaultLetter('สมชาย')).toBe('ส');
  });

  it('returns ? for an empty or blank name', () => {
    expect(defaultLetter('')).toBe('?');
    expect(defaultLetter('   ')).toBe('?');
  });

  it('accepts digits as the letter', () => {
    expect(defaultLetter('2nd account')).toBe('2A');
  });
});

describe('isLimited', () => {
  const win = (pct: number, resetsAt: number | null) => ({ pct, resetsAt });

  it('is false without usage', () => {
    expect(isLimited(withUsage(null), NOW)).toBe(false);
  });

  it('is false below 99 %', () => {
    expect(isLimited(withUsage({ fiveHour: win(98, NOW + 1000), sevenDay: null, updatedAt: NOW }), NOW)).toBe(false);
  });

  it('is true at 99 % with a reset in the future', () => {
    expect(isLimited(withUsage({ fiveHour: win(99, NOW + 1000), sevenDay: null, updatedAt: NOW }), NOW)).toBe(true);
  });

  it('is false at 99 % when the reset is in the past', () => {
    expect(isLimited(withUsage({ fiveHour: win(100, NOW - 1), sevenDay: null, updatedAt: NOW }), NOW)).toBe(false);
  });

  it('is true at 100 % when resetsAt is null', () => {
    expect(isLimited(withUsage({ fiveHour: null, sevenDay: win(100, null), updatedAt: NOW }), NOW)).toBe(true);
  });

  it('is true when only the 7 d window is over the limit', () => {
    expect(isLimited(withUsage({ fiveHour: win(10, NOW + 1), sevenDay: win(99, NOW + DAY), updatedAt: NOW }), NOW)).toBe(true);
  });

  it('is false when both windows are null', () => {
    expect(isLimited(withUsage({ fiveHour: null, sevenDay: null, updatedAt: NOW }), NOW)).toBe(false);
  });
});

describe('ACCOUNT_ID_RE', () => {
  it('accepts slugs and rejects uppercase, spaces and empty', () => {
    expect(ACCOUNT_ID_RE.test('work-1')).toBe(true);
    expect(ACCOUNT_ID_RE.test('Work')).toBe(false);
    expect(ACCOUNT_ID_RE.test('a b')).toBe(false);
    expect(ACCOUNT_ID_RE.test('')).toBe(false);
    expect(ACCOUNT_ID_RE.test('a'.repeat(65))).toBe(false);
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain, masks the rest of the local part', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
  });

  it('returns an empty string for null, undefined or an empty value', () => {
    expect(maskEmail(null)).toBe('');
    expect(maskEmail(undefined)).toBe('');
    expect(maskEmail('')).toBe('');
  });

  it('masks the whole value to first char + *** when there is no @', () => {
    expect(maskEmail('bob')).toBe('b***');
  });

  it('handles an empty local part without leaking anything', () => {
    expect(maskEmail('@example.com')).toBe('***@example.com');
  });

  it('never returns the full address', () => {
    const e = 'secret.person@example.com';
    expect(maskEmail(e)).not.toContain('secret');
    expect(maskEmail(e)).not.toContain('person');
  });
});

describe('validatePin', () => {
  it('accepts exactly 6 ASCII digits', () => {
    expect(validatePin('000000')).toBe(true);
    expect(validatePin('482913')).toBe(true);
    expect(PIN_RE.test('482913')).toBe(true);
  });

  it('rejects any other length, letters, spaces, newlines, non-ASCII digits and non-strings', () => {
    expect(validatePin('12345')).toBe(false);
    expect(validatePin('1234567')).toBe(false);
    expect(validatePin('')).toBe(false);
    expect(validatePin('12345a')).toBe(false);
    expect(validatePin(' 123456')).toBe(false);
    expect(validatePin('123456\n')).toBe(false);
    expect(validatePin('１２３４５６')).toBe(false); // full-width digits
    expect(validatePin('١٢٣٤٥٦')).toBe(false); // Arabic-Indic digits
    expect(validatePin(123456)).toBe(false);
    expect(validatePin(null)).toBe(false);
    expect(validatePin(undefined)).toBe(false);
  });
});

describe('validatePassword', () => {
  it('accepts strings of 4..128 code points', () => {
    expect(validatePassword('abcd')).toBe(true);
    expect(validatePassword('a'.repeat(128))).toBe(true);
    expect(validatePassword('รหัสผ่าน')).toBe(true);
  });

  it('rejects shorter than 4, longer than 128 and non-strings', () => {
    expect(validatePassword('abc')).toBe(false);
    expect(validatePassword('a'.repeat(129))).toBe(false);
    expect(validatePassword(1234)).toBe(false);
    expect(validatePassword(null)).toBe(false);
    expect(validatePassword(undefined)).toBe(false);
  });

  it('counts code points, so one emoji is one character', () => {
    expect(validatePassword('😀😀😀😀')).toBe(true);
    expect(validatePassword('😀😀😀')).toBe(false);
  });

  it('does not trim the password', () => {
    expect(validatePassword('    ')).toBe(true);
    expect(validatePassword(' ab ')).toBe(true);
  });
});

describe('validateLoginCode', () => {
  it('returns the trimmed code for a normal pasted code', () => {
    expect(validateLoginCode('  abc123-XYZ  ')).toBe('abc123-XYZ');
  });

  it('returns null for empty, whitespace-only or non-string input', () => {
    expect(validateLoginCode('')).toBeNull();
    expect(validateLoginCode('   ')).toBeNull();
    expect(validateLoginCode(42)).toBeNull();
    expect(validateLoginCode(undefined)).toBeNull();
  });

  it('caps the length at LOGIN_CODE_MAX characters', () => {
    expect(validateLoginCode('a'.repeat(LOGIN_CODE_MAX))).toBe('a'.repeat(LOGIN_CODE_MAX));
    expect(validateLoginCode('a'.repeat(LOGIN_CODE_MAX + 1))).toBeNull();
  });

  it('rejects control characters, including a newline inside the code', () => {
    expect(validateLoginCode('ab\ncd')).toBeNull();
    expect(validateLoginCode('ab\u0007cd')).toBeNull();
    expect(validateLoginCode('ab\u009fcd')).toBeNull();
  });
});

describe('reserved ids and the main account', () => {
  it('reserves main so no profile can take the id', () => {
    expect(RESERVED_ACCOUNT_IDS).toContain('main');
    expect(RESERVED_ACCOUNT_IDS).toContain('terminal');
  });
});
