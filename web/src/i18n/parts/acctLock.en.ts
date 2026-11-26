// English account lock strings. Must match acctLockTh keys.
import type { acctLockTh } from './acctLock.th';
export const acctLockEn: Record<keyof typeof acctLockTh, string> = {
  'acct.lock.dlg.title': 'Unlock profile',
  'acct.lock.dlg.hint': 'Enter this profile’s password to use it.',
  'acct.lock.dlg.close': 'Close',
  'acct.lock.password': 'Password',
  'acct.lock.submit': 'Unlock',
  'acct.lock.err.BAD_PASSWORD': 'Wrong password.',
  'acct.lock.err.TOO_MANY_TRIES': 'Too many wrong tries. Wait 30 seconds.',
  'acct.lock.app.title': 'Enter the app PIN',
  'acct.lock.app.hint': 'This app is locked with a 6-digit PIN. Enter it to continue.',
};
