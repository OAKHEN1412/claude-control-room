// Pure logic for the per-job account chip (3B) and the usage-limit switch card (3C). No React, no I/O.
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID, isLimited, type AccountInfo } from '../../shared/accounts';
import type { RunnerState } from '../../shared/protocol';
import { badgeOf, displayLetter, needsUnlock, profileById, usageOfProfile, withUsage, type UsageBadge } from './accountsView';
import type { UsageSnapshot } from '../../shared/usage';
import { tx } from './i18n';

/** The account slice of the accounts context that this logic reads. */
export interface AccountsSnapshot {
  accounts: AccountInfo[];
  defaultAccountId: string;
}

export interface ChipAvatar {
  letter: string;
  color: string;
  /** Built-in main account: AccountAvatar needs these to show the email letter. */
  builtin?: boolean;
  main?: AccountInfo['main'];
}

export interface ChipModel {
  /** False for remote jobs and when there is no runner: the chip is not shown. */
  visible: boolean;
  /** Profile id the job runs as (falls back to the default profile). */
  id: string;
  /** Display name: the Terminal profile's name, the profile name, or the id when unknown. */
  name: string;
  avatar: ChipAvatar;
  /** True when a switch may be requested now (alive, local). */
  enabled: boolean;
  /** Name of the profile a queued switch is waiting for, else null. */
  pendingName: string | null;
  /** Profile a waiting job needs unlocked (RunnerState.waitingUnlock), else null. */
  waitingFor: string | null;
  /** "รอปลดล็อก <profile>" while the job waits for its locked profile, else null. */
  waitingLabel: string | null;
  /** True when the job's profile is sealed by a password (shows the lock icon). */
  locked: boolean;
}

/** Server error code for a start or set_account on a profile that is still locked. */
export const LOCKED_CODE = 'srv.account.locked';

/**
 * True when a command failed because the profile is locked. The code may arrive raw (code / error) or already
 * translated into the error text (the translated form of LOCKED_CODE), so all three are checked.
 */
export function isLockedFailure(r: { ok?: boolean; code?: string; error?: string }): boolean {
  if (r.ok) return false;
  return r.code === LOCKED_CODE || r.error === LOCKED_CODE || (!!r.error && r.error === tx(LOCKED_CODE));
}

/** True when a profile id names a locked row in the accounts list. */
export function isLockedProfile(accounts: AccountInfo[], id: string): boolean {
  const a = profileById(accounts, id);
  return !!a && needsUnlock(a);
}

/** "รอปลดล็อก <name>" for a job that waits for its locked profile. */
export function waitingLabel(name: string): string {
  return tx('acct.job.waitingUnlock', { name });
}

const FALLBACK_AVATAR: ChipAvatar = { letter: '?', color: ACCOUNT_COLORS[0] };

/** Display name of a profile row. The built-in Terminal profile always uses its fixed label. */
export function profileName(a: Pick<AccountInfo, 'id' | 'name' | 'builtin'>): string {
  if (a.builtin || a.id === TERMINAL_ACCOUNT_ID) return tx('acct.terminal.name');
  return a.name;
}

/** Display name for any profile id: a known row, the Terminal label, or the id itself. */
export function nameOfId(accounts: AccountInfo[], id: string): string {
  const a = profileById(accounts, id);
  if (a) return profileName(a);
  if (id === TERMINAL_ACCOUNT_ID) return tx('acct.terminal.name');
  return id;
}

function avatarOfId(accounts: AccountInfo[], id: string): ChipAvatar {
  const a = profileById(accounts, id);
  if (a) {
    const color = (ACCOUNT_COLORS as readonly string[]).includes(a.color) ? a.color : ACCOUNT_COLORS[0];
    return { letter: displayLetter(a), color, builtin: a.builtin, main: a.main };
  }
  if (id === TERMINAL_ACCOUNT_ID) return { letter: displayLetter({ letter: '', builtin: true }), color: ACCOUNT_COLORS[0], builtin: true };
  return FALLBACK_AVATAR;
}

/** Profile a job runs as: the runner's accountId, else the default profile, else the Terminal login. */
export function currentAccountId(runner: Pick<RunnerState, 'accountId'> | undefined, defaultId: string): string {
  return runner?.accountId ?? (defaultId || TERMINAL_ACCOUNT_ID);
}

/** A switch can be requested only for a live job that this web controls (no remote machine). */
export function canSwitch(runner: Pick<RunnerState, 'alive' | 'machineId'> | undefined): boolean {
  return !!runner && runner.alive && !runner.machineId;
}

/** A job is local when it has a runner and neither side names a remote machine. */
export function isLocalJob(
  session: { machineId?: string } | null | undefined,
  runner: Pick<RunnerState, 'machineId'> | undefined,
): boolean {
  return !!runner && !runner.machineId && !session?.machineId;
}

/** Model for the account chip on a job card or pane header. */
export function chipModel(runner: RunnerState | undefined, accounts: AccountsSnapshot): ChipModel {
  if (!runner || runner.machineId) {
    return {
      visible: false,
      id: TERMINAL_ACCOUNT_ID,
      name: '',
      avatar: FALLBACK_AVATAR,
      enabled: false,
      pendingName: null,
      waitingFor: null,
      waitingLabel: null,
      locked: false,
    };
  }
  // A job waiting for its locked profile names that profile; otherwise the profile the job runs as.
  const waitingFor = runner.waitingUnlock ?? null;
  const id = waitingFor ?? currentAccountId(runner, accounts.defaultAccountId);
  return {
    visible: true,
    id,
    name: nameOfId(accounts.accounts, id),
    avatar: avatarOfId(accounts.accounts, id),
    enabled: canSwitch(runner),
    pendingName: runner.accountPending ? nameOfId(accounts.accounts, runner.accountPending) : null,
    waitingFor,
    waitingLabel: waitingFor ? waitingLabel(nameOfId(accounts.accounts, waitingFor)) : null,
    locked: isLockedProfile(accounts.accounts, id),
  };
}

/** Which confirm sentence applies: a busy or queued job waits for the turn to end first. */
export function confirmKey(busy: boolean): 'acct.job.switchWhenBusy' | 'acct.job.switchNow' {
  return busy ? 'acct.job.switchWhenBusy' : 'acct.job.switchNow';
}

/** "จะสลับเป็น <name> · <detail>" for the confirm panel. */
export function confirmText(name: string, busy: boolean): string {
  return tx('acct.job.confirmText', { name, detail: tx(confirmKey(busy)) });
}

/**
 * Other visible profiles, not limited first, then lowest weekly usage first (unknown usage last).
 * `usage` is the global snapshot: the built-in main account is ranked by it like any token profile.
 */
export function alternatives(accounts: AccountInfo[], currentId: string, now: number, usage?: UsageSnapshot): AccountInfo[] {
  const weekOf = (a: AccountInfo): number => usageOfProfile(a, usage)?.sevenDay?.pct ?? Number.POSITIVE_INFINITY;
  const limitRank = (a: AccountInfo): number => (isLimited(withUsage(a, usage), now) ? 1 : 0);
  return accounts
    .filter((a) => !a.hidden && a.id !== currentId)
    .map((a, index) => ({ a, index }))
    .sort((x, y) => {
      const byLimit = limitRank(x.a) - limitRank(y.a);
      if (byLimit !== 0) return byLimit;
      const wx = weekOf(x.a);
      const wy = weekOf(y.a);
      if (wx !== wy) return wx < wy ? -1 : 1;
      return x.index - y.index;
    })
    .map((x) => x.a);
}

/** A profile can take over a job when it is the Terminal login or has a token saved. */
export function hasSwitchableToken(a: Pick<AccountInfo, 'builtin' | 'tokenState'>): boolean {
  return a.builtin || a.tokenState === 'set';
}

export interface LimitRow {
  account: AccountInfo;
  name: string;
  limited: boolean;
  badge: UsageBadge;
}

/** Rows of the usage-limit card: other visible profiles with a token; limited ones stay listed but disabled. `usage` is the global snapshot. */
export function limitRows(accounts: AccountInfo[], currentId: string, now: number, usage?: UsageSnapshot): LimitRow[] {
  return alternatives(accounts, currentId, now, usage)
    .filter(hasSwitchableToken)
    .map((account) => ({
      account,
      name: profileName(account),
      limited: isLimited(withUsage(account, usage), now),
      badge: badgeOf(account, now, usage),
    }));
}

/** "รอสลับเป็น <name>…" while a switch waits for the turn to end; null otherwise. */
export function pendingLabel(pendingId: string | null | undefined, accounts: AccountInfo[]): string | null {
  if (!pendingId) return null;
  return tx('acct.job.pending', { name: nameOfId(accounts, pendingId) });
}
