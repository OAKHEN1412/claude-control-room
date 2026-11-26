// Pure decisions for the account (profile) controls on the v2 canvas: the avatar on a session card,
// the waiting label on a card, and the "บัญชี" row in the model/mode popover. No React, no I/O.
import type { AccountInfo } from '../../shared/accounts';
import type { RunnerState } from '../../shared/protocol';
import { visibleProfiles, needsUnlock } from './accountsView';
import { canSwitch, chipModel, currentAccountId, hasSwitchableToken, isLocalJob, isLockedProfile, nameOfId, profileName, type AccountsSnapshot } from './accountJobLogic';

/** Avatar on a session card: only for a live local job (no remote machine). */
export function showCardAvatar(runner: RunnerState | undefined): boolean {
  return isLocalJob(undefined, runner) && !!runner && runner.alive;
}

/** What the card needs to draw the avatar, or null when no avatar is shown. `name` is the tooltip / aria label. */
export interface CardAvatar {
  name: string;
  letter: string;
  color: string;
  builtin?: boolean;
  main?: AccountInfo['main'];
}

export function cardAvatar(runner: RunnerState | undefined, accounts: AccountsSnapshot): CardAvatar | null {
  if (!showCardAvatar(runner)) return null;
  const m = chipModel(runner, accounts);
  return { name: m.name, letter: m.avatar.letter, color: m.avatar.color, builtin: m.avatar.builtin, main: m.avatar.main };
}

/** "รอปลดล็อก <name>" on a card whose job waits for a locked profile; null otherwise (local jobs only). */
export function cardWaiting(runner: RunnerState | undefined, accounts: AccountsSnapshot): string | null {
  if (!isLocalJob(undefined, runner)) return null;
  return chipModel(runner, accounts).waitingLabel;
}

export interface PopoverOption {
  id: string;
  label: string;
  locked: boolean;
}

export interface PopoverRow {
  /** False for remote jobs and when there is no runner: the row is not shown. */
  visible: boolean;
  /** Profile the job runs as: the option that is ticked. */
  value: string;
  /** Visible profiles that can take over the job (Terminal or token saved), plus the current one. */
  options: PopoverOption[];
  /** True when a switch cannot be requested now (job not alive). */
  disabled: boolean;
  /** i18n key that explains `disabled`, or null. */
  reasonKey: 'acct.job.notAlive' | null;
}

/** Model for the "บัญชี" row of the model/mode popover on a local job. */
export function popoverRow(runner: RunnerState | undefined, accounts: AccountsSnapshot): PopoverRow {
  if (!isLocalJob(undefined, runner) || !runner) {
    return { visible: false, value: '', options: [], disabled: true, reasonKey: null };
  }
  const current = currentAccountId(runner, accounts.defaultAccountId);
  const options: PopoverOption[] = visibleProfiles(accounts.accounts, accounts.defaultAccountId)
    .filter((a) => a.id === current || hasSwitchableToken(a))
    .map((a) => ({ id: a.id, label: profileName(a), locked: needsUnlock(a) }));
  if (!options.some((o) => o.id === current)) {
    options.unshift({ id: current, label: nameOfId(accounts.accounts, current), locked: isLockedProfile(accounts.accounts, current) });
  }
  const enabled = canSwitch(runner);
  return { visible: true, value: current, options, disabled: !enabled, reasonKey: enabled ? null : 'acct.job.notAlive' };
}
