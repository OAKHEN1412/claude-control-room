// Pure logic for the header account menu (avatar pill + popover) and the switch toast.
// No React. The component renders what these functions return.
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID, type AccountInfo } from '../../shared/accounts';
import type { RunnerState } from '../../shared/protocol';
import type { UsageSnapshot } from '../../shared/usage';
import { badgeOf, maskedEmail, profileById, visibleProfiles, weekAndFiveHour, errText, type UsageBadge } from './accountsView';
import { tx } from './i18n';

/** What the avatar needs. The terminal fallback (no accounts from an old server) uses this shape too. */
export type AvatarProfile = Pick<AccountInfo, 'id' | 'name' | 'color' | 'letter'> & Partial<Pick<AccountInfo, 'builtin' | 'main'>>;

export interface PopoverModel {
  /** The default profile for new jobs (shown big in the popover and on the pill). */
  current: AvatarProfile;
  /** Other visible profiles, server order, the current one left out. */
  others: AccountInfo[];
  /** 5 h and 7 d percentages of the current profile; null = unknown. */
  five: number | null;
  seven: number | null;
  /** True when the server sent no profile at all, so the pill shows the built-in Terminal login. */
  fallback: boolean;
}

/**
 * Builds the popover view-model. The current profile is always listed, even when hidden.
 * `usage` is the global snapshot (AccountsCtx.usage): it supplies the bars of the built-in main account.
 */
export function popoverModel(accounts: AccountInfo[], defaultId: string, usage?: UsageSnapshot): PopoverModel {
  const found = profileById(accounts, defaultId) ?? accounts[0];
  if (!found) {
    return {
      current: { id: TERMINAL_ACCOUNT_ID, name: '', color: ACCOUNT_COLORS[0], letter: '', builtin: true },
      others: [],
      five: null,
      seven: null,
      fallback: true,
    };
  }
  const current: AvatarProfile = {
    id: found.id,
    name: found.name,
    color: found.color,
    letter: found.letter,
    builtin: found.builtin,
    main: found.main,
  };
  const others = visibleProfiles(accounts, found.id).filter((a) => a.id !== found.id);
  const { five, seven } = weekAndFiveHour(found, usage);
  return { current, others, five, seven, fallback: false };
}

/**
 * Line under a profile's name in the popover. The built-in main account shows its email, masked (a***@domain);
 * a full address is never shown here. A token profile shows its note. Empty when there is nothing to show.
 */
export function popoverSubline(current: AccountInfo | undefined): string {
  if (!current) return '';
  if (current.builtin) return maskedEmail(current);
  return (current.note ?? '').trim();
}

/**
 * Usage badge for a row in the popover: 'limit' at the cap, else the week %. The built-in main account reads the
 * global snapshot (the one the header rings show); nothing when that snapshot has no quota.
 */
export function popoverBadge(a: AccountInfo, now: number, usage?: UsageSnapshot): UsageBadge {
  return badgeOf(a, now, usage);
}

/** Width of a usage bar in percent, clamped to 0..100. Unknown reads as an empty bar. */
export function barWidth(pct: number | null): number {
  if (pct === null || !Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/** Text for a usage value: '—' when unknown. */
export function pctText(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`;
}

/**
 * Session ids of the local jobs that are idle and may move to another profile without
 * interrupting anything: runner alive, no turn running, nothing queued, not a remote machine job,
 * not already on targetId, and no switch already pending.
 */
export function idleJobsToMove(runners: Record<string, RunnerState>, targetId: string): string[] {
  return Object.values(runners)
    .filter(
      (r) =>
        r.alive &&
        !r.busy &&
        r.queued === 0 &&
        !r.machineId &&
        r.accountId !== targetId &&
        !r.accountPending,
    )
    .map((r) => r.sessionId);
}

/** Outcome of moving several jobs: how many succeeded and the first error code (null when none failed). */
export function summarizeMoves(results: { ok: boolean; error?: string }[]): { moved: number; firstError: string | null } {
  let moved = 0;
  let firstError: string | null = null;
  for (const r of results) {
    if (r.ok) moved += 1;
    else if (firstError === null) firstError = r.error ?? 'SERVER_ERROR';
  }
  return { moved, firstError };
}

/** Text for an error code. Server codes (srv.*) come from the i18n dictionary, API codes from acct.err.*. */
export function moveErrorText(code: string): string {
  if (code.startsWith('srv.')) return tx(code, undefined, tx('acct.err.SERVER_ERROR'));
  return errText(code);
}

/** True when the event target is outside the root element (used for the outside-click close). */
export function isOutside(root: { contains(n: unknown): boolean } | null, target: unknown): boolean {
  return root === null || !root.contains(target);
}

/** Auto-hide delay for the toast, in ms. */
export const TOAST_HIDE_MS = 8000;

export type ToastState =
  | { kind: 'switched'; accountId: string; name: string }
  | { kind: 'moved'; n: number; error: string | null }
  | { kind: 'none' }
  | { kind: 'error'; text: string };
