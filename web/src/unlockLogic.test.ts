import { describe, expect, it } from 'vitest';
import { th } from './i18n/th';
import { en } from './i18n/en';
import { authGateView, canSubmit, unlockErrorKey, unlockErrorText } from './unlockLogic';

describe('unlockErrorKey', () => {
  it('maps the lock-specific codes to acct.lock.err keys', () => {
    expect(unlockErrorKey('BAD_PASSWORD')).toBe('acct.lock.err.BAD_PASSWORD');
    expect(unlockErrorKey('TOO_MANY_TRIES')).toBe('acct.lock.err.TOO_MANY_TRIES');
  });

  it('returns null for other codes and prototype keys', () => {
    expect(unlockErrorKey('NOT_FOUND')).toBeNull();
    expect(unlockErrorKey('toString')).toBeNull();
    expect(unlockErrorKey('')).toBeNull();
  });

  it('has the Thai and English text for both lock errors', () => {
    expect(unlockErrorText('BAD_PASSWORD')).toBe(th['acct.lock.err.BAD_PASSWORD']);
    expect(th['acct.lock.err.TOO_MANY_TRIES']).toBe('ลองผิดหลายครั้ง รอ 30 วินาที');
    expect(en['acct.lock.err.TOO_MANY_TRIES']).toMatch(/30 seconds/);
  });

  it('falls back to the shared account error text for other codes', () => {
    expect(unlockErrorText('NETWORK')).toBe(th['acct.err.NETWORK']);
  });
});

describe('canSubmit', () => {
  it('accepts any non-empty password, including spaces', () => {
    expect(canSubmit('a')).toBe(true);
    expect(canSubmit('  ')).toBe(true);
  });

  it('rejects an empty password', () => {
    expect(canSubmit('')).toBe(false);
  });
});

describe('authGateView', () => {
  it('is loading while the state has not arrived', () => {
    expect(authGateView(undefined)).toBe('loading');
  });

  it('treats a failed request (null) as open', () => {
    expect(authGateView(null)).toBe('open');
  });

  it('is locked only when a password is set and this browser is not unlocked', () => {
    expect(authGateView({ required: true, unlocked: false })).toBe('locked');
    expect(authGateView({ required: true, unlocked: true })).toBe('open');
    expect(authGateView({ required: false, unlocked: true })).toBe('open');
    expect(authGateView({ required: false, unlocked: false })).toBe('open');
  });
});
