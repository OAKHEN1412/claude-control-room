import { describe, expect, it } from 'vitest';
import { checkChangeForm, checkNewPassword, checkRemoveForm, checkSetForm, pwErrorKey } from './passwordLogic';

describe('password form validators', () => {
  it('rejects a new password shorter than 4 or longer than 128 code points', () => {
    expect(checkNewPassword('abc', 'abc')).toEqual({ ok: false, error: 'PASSWORD_INVALID' });
    expect(checkNewPassword('abcd', 'abcd')).toEqual({ ok: true });
    expect(checkNewPassword('a'.repeat(128), 'a'.repeat(128))).toEqual({ ok: true });
    expect(checkNewPassword('a'.repeat(129), 'a'.repeat(129))).toEqual({ ok: false, error: 'PASSWORD_INVALID' });
  });

  it('counts Thai characters as code points and does not trim', () => {
    expect(checkNewPassword('รหัสผ่าน', 'รหัสผ่าน')).toEqual({ ok: true });
    expect(checkNewPassword('abc ', 'abc ')).toEqual({ ok: true });
    expect(checkNewPassword('abc ', 'abc')).toEqual({ ok: false, error: 'MISMATCH' });
  });

  it('reports a mismatch after the length check passes', () => {
    expect(checkSetForm('pass1', 'pass2')).toEqual({ ok: false, error: 'MISMATCH' });
    expect(checkSetForm('pass1', 'pass1')).toEqual({ ok: true });
  });

  it('change form needs the current password first', () => {
    expect(checkChangeForm('', 'newpass', 'newpass')).toEqual({ ok: false, error: 'CURRENT_REQUIRED' });
    expect(checkChangeForm('old', 'newpass', 'other')).toEqual({ ok: false, error: 'MISMATCH' });
    expect(checkChangeForm('old', 'newpass', 'newpass')).toEqual({ ok: true });
  });

  it('remove form needs only the current password', () => {
    expect(checkRemoveForm('')).toEqual({ ok: false, error: 'CURRENT_REQUIRED' });
    expect(checkRemoveForm('old')).toEqual({ ok: true });
  });
});

describe('pwErrorKey', () => {
  it('maps the known password codes to acct.mng.pw.err keys', () => {
    for (const code of ['BAD_PASSWORD', 'PASSWORD_INVALID', 'TOO_MANY_TRIES', 'PROFILE_LOCKED', 'NO_PASSWORD', 'LOCKED', 'MISMATCH', 'CURRENT_REQUIRED']) {
      expect(pwErrorKey(code)).toBe(`acct.mng.pw.err.${code}`);
    }
  });

  it('returns null for unknown codes so the caller falls back to errText', () => {
    expect(pwErrorKey('NETWORK')).toBeNull();
    expect(pwErrorKey('')).toBeNull();
  });
});
