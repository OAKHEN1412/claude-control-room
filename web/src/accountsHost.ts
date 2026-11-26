// Pure helpers for AccountsHost (the one place that owns the account dialogs). No React, no I/O.
import type { AccountInfo } from '../../shared/accounts';
import { serverText } from './i18n/serverMsg';

/** Result shape of a server `set_account` command (CommandResult carries code/vars when the server sends them). */
export interface SetAccountReply {
  ok: boolean;
  error?: string;
  code?: string;
  vars?: Record<string, string | number>;
}

/** Maps a set_account reply to the ok/error shape the account context exposes. Error text is translated when the code is known. */
export function setAccountOutcome(r: SetAccountReply): { ok: true } | { ok: false; error: string } {
  return r.ok ? { ok: true } : { ok: false, error: serverText(r) || 'SERVER_ERROR' };
}

/** The unlock request: which locked profile, and what to run once it is unlocked. */
export interface UnlockRequest {
  accountId: string;
  then?: () => void;
}

/** Dialog state owned by AccountsHost: the add dialog (with an optional profile to reconnect) and the unlock dialog. */
export interface HostDialogs {
  addOpen: boolean;
  addAccountId: string | undefined;
  unlock: UnlockRequest | null;
}

export type HostDialogAction =
  | { type: 'openAdd'; accountId?: string }
  | { type: 'closeAdd' }
  | { type: 'openUnlock'; accountId: string; then?: () => void }
  | { type: 'closeUnlock' };

export const INITIAL_DIALOGS: HostDialogs = { addOpen: false, addAccountId: undefined, unlock: null };

export function dialogsReducer(state: HostDialogs, action: HostDialogAction): HostDialogs {
  switch (action.type) {
    case 'openAdd':
      return { ...state, addOpen: true, addAccountId: action.accountId };
    case 'closeAdd':
      return state.addOpen ? { ...state, addOpen: false } : state;
    case 'openUnlock':
      return { ...state, unlock: { accountId: action.accountId, then: action.then } };
    case 'closeUnlock':
      return state.unlock === null ? state : { ...state, unlock: null };
  }
}

/** The profile the unlock dialog is about, or null when none is requested or it no longer exists. */
export function unlockAccountOf(accounts: readonly AccountInfo[], unlock: UnlockRequest | null): AccountInfo | null {
  if (!unlock) return null;
  return accounts.find((a) => a.id === unlock.accountId) ?? null;
}
