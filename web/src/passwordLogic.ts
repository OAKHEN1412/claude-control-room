// Pure form validators and error-key mapping for the password forms (token profiles and the app lock).
// No React, no I/O. Passwords are never trimmed: what the user typed is what is compared and sent.
import { validatePassword } from '../../shared/accounts';

export type PwFormError = 'CURRENT_REQUIRED' | 'MISMATCH' | 'PASSWORD_INVALID';
export type PwCheck = { ok: true } | { ok: false; error: PwFormError };

/** New password + confirmation. Length first (4..128), then the match. */
export function checkNewPassword(next: string, confirm: string): PwCheck {
  if (!validatePassword(next)) return { ok: false, error: 'PASSWORD_INVALID' };
  if (next !== confirm) return { ok: false, error: 'MISMATCH' };
  return { ok: true };
}

/** Set form (no password yet): new + confirm. */
export function checkSetForm(next: string, confirm: string): PwCheck {
  return checkNewPassword(next, confirm);
}

/** Change form: the current password is required, then the new one. */
export function checkChangeForm(current: string, next: string, confirm: string): PwCheck {
  if (current === '') return { ok: false, error: 'CURRENT_REQUIRED' };
  return checkNewPassword(next, confirm);
}

/** Remove form: only the current password. */
export function checkRemoveForm(current: string): PwCheck {
  if (current === '') return { ok: false, error: 'CURRENT_REQUIRED' };
  return { ok: true };
}

const KNOWN_PW_CODES: readonly string[] = [
  'BAD_PASSWORD',
  'PASSWORD_INVALID',
  'TOO_MANY_TRIES',
  'PROFILE_LOCKED',
  'NO_PASSWORD',
  'LOCKED',
  'MISMATCH',
  'CURRENT_REQUIRED',
];

/** i18n key for a password error (local or server code), or null when the caller should fall back to errText. */
export function pwErrorKey(code: string): string | null {
  return KNOWN_PW_CODES.includes(code) ? `acct.mng.pw.err.${code}` : null;
}
