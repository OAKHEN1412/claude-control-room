// English strings for the header account pill, popover and switch toast. Must match acctPopoverTh keys.
import type { acctPopoverTh } from './acctPopover.th';
export const acctPopoverEn: Record<keyof typeof acctPopoverTh, string> = {
  'acct.pop.pill': 'Profile: {name}',
  'acct.pop.menu': 'Choose profile',
  'acct.pop.hello': 'Hi, {name}',
  'acct.pop.current': 'Current default',
  'acct.pop.five': '5 h',
  'acct.pop.week': 'Week',
  'acct.pop.manage': 'Manage profiles',
  'acct.pop.others': 'Other profiles',
  'acct.pop.add': '+ Add profile',
  'acct.pop.footer': 'Changing it here sets the default for new jobs · running jobs are not moved',
  'acct.pop.toast': 'New jobs will use {name} · running jobs keep their current account',
  'acct.pop.moveIdle': 'Move idle jobs too',
  'acct.pop.moved': 'Moved {n} jobs',
  'acct.pop.noneIdle': 'No idle jobs to move',
  'acct.pop.moveFailed': 'Move failed: {error}',
  'acct.pop.dismiss': 'Close',
  'acct.pop.locked': 'Locked',
  'acct.pop.unlockCurrent': 'Locked — click to unlock',
};
