// Pure logic for the unlock dialog (UnlockDialog), the app lock page (AppLockPage) and the auth gate (main.tsx).
// No React here: the components call these helpers.
import { errText } from './accountsView';
import { tx } from './i18n';
import type { AuthState } from './authClient';

export type AuthGateView = 'loading' | 'locked' | 'open';

/** Lock-specific error keys. Other codes go through errText (acct.err.*). */
const LOCK_ERROR_KEYS: Readonly<Record<string, string>> = {
  BAD_PASSWORD: 'acct.lock.err.BAD_PASSWORD',
  TOO_MANY_TRIES: 'acct.lock.err.TOO_MANY_TRIES',
};

/** The acct.lock.* key for an error code, or null when the code has no lock-specific text. */
export function unlockErrorKey(code: string): string | null {
  return Object.prototype.hasOwnProperty.call(LOCK_ERROR_KEYS, code) ? LOCK_ERROR_KEYS[code] : null;
}

/** Human text for an unlock error code (lock text first, then the shared account error text). */
export function unlockErrorText(code: string): string {
  const key = unlockErrorKey(code);
  return key ? tx(key) : errText(code);
}

/** The submit button is enabled for any non-empty password (a password may contain spaces, so no trimming). */
export function canSubmit(password: string): boolean {
  return password.length > 0;
}

/**
 * What the app-lock gate shows.
 * undefined = the state is still loading; null = the request failed (an older server or a 404): treated as not required.
 */
export function authGateView(state: AuthState | null | undefined): AuthGateView {
  if (state === undefined) return 'loading';
  if (state === null) return 'open';
  return state.required && !state.unlocked ? 'locked' : 'open';
}
