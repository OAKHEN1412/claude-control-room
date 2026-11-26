// Account choice of the new-job form: the profiles the select offers, their labels, and whether the
// user's pick goes into the start command. Pure; no React, no I/O.
import { isLimited, type AccountInfo } from '../../shared/accounts';
import { visibleProfiles } from './accountsView';

export interface AccountOption {
  id: string;
  label: string;
}

export interface AccountOptionNames {
  /** Name shown for the built-in Terminal login profile. */
  terminal: string;
  /** Suffix word shown for a profile at its usage limit (e.g. "ติด limit"). */
  limit: string;
}

/**
 * Options of the account select: visible profiles, default first. A profile with no token that is not
 * built in is left out (it cannot run a job). A profile at its limit gets " · <limit>" after its name.
 */
export function accountOptions(accounts: AccountInfo[], defaultId: string, now: number, names: AccountOptionNames): AccountOption[] {
  return visibleProfiles(accounts, defaultId)
    .filter((a) => a.builtin || a.tokenState === 'set')
    .map((a) => ({
      id: a.id,
      label: `${a.builtin ? names.terminal : a.name}${isLimited(a, now) ? ` · ${names.limit}` : ''}`,
    }));
}

/** The option the select shows: the user's pick while it is still offered, else the default, else the first. */
export function resolveAccountSelection(options: AccountOption[], picked: string, defaultId: string): string {
  if (options.some((o) => o.id === picked)) return picked;
  if (options.some((o) => o.id === defaultId)) return defaultId;
  return options[0]?.id ?? '';
}

/** The select is shown only for a job on this PC and only when there is a real choice. */
export function showAccountSelect(options: AccountOption[], remoteTarget: boolean): boolean {
  return !remoteTarget && options.length > 1;
}

/**
 * accountId for the start command. Only the user's explicit pick is sent, and only when it differs from the
 * default and the job runs on this PC (accounts are local). Untouched form: undefined, nothing changes.
 */
export function accountIdToSend(picked: string, defaultId: string, remoteTarget: boolean): string | undefined {
  if (remoteTarget || picked === '' || picked === defaultId) return undefined;
  return picked;
}
