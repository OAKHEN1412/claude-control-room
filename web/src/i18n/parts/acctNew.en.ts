import type { acctNewTh } from './acctNew.th';
// English strings for the new-job account select and the account-switch divider. Must match acctNewTh keys.
export const acctNewEn: Record<keyof typeof acctNewTh, string> = {
  'acct.new.account': 'Account',
  'acct.tl.switch': '— Switched account {from} → {to} {time} —',
  'acct.new.locked': 'Locked',
};
