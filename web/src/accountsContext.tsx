// React context for the account (profile) UI. App builds the value from useServer() and wraps the tree;
// components read it with useAccounts(). Without a provider, useAccounts() returns an empty, inert value.
import { createContext, useContext, type ReactNode } from 'react';
import type { AccountInfo, ConnectEvent, MainLoginEvent } from '../../shared/accounts';
import type { UsageSnapshot } from '../../shared/usage';

export interface AccountsCtx {
  accounts: AccountInfo[];
  defaultAccountId: string;
  ptyAvailable: boolean;
  connect: ConnectEvent | null;
  mainLogin: MainLoginEvent | null; // latest login event of the main account
  /** Global usage snapshot (the header rings' source). The built-in main account's usage comes from it. */
  usage?: UsageSnapshot;
  setAccount(sessionId: string, accountId: string): Promise<{ ok: boolean; error?: string }>;
  openAddDialog(accountId?: string): void;
  /** Opens the unlock dialog for a locked profile; `then` runs once it is unlocked. */
  openUnlockDialog(accountId: string, then?: () => void): void;
}

const EMPTY: AccountsCtx = {
  accounts: [],
  defaultAccountId: 'terminal',
  ptyAvailable: false,
  connect: null,
  mainLogin: null,
  setAccount: async () => ({ ok: false, error: 'NO_PROVIDER' }),
  openAddDialog: () => {},
  openUnlockDialog: () => {},
};

const Ctx = createContext<AccountsCtx | null>(null);

export function AccountsProvider(props: { value: AccountsCtx; children: ReactNode }) {
  return <Ctx.Provider value={props.value}>{props.children}</Ctx.Provider>;
}

export function useAccounts(): AccountsCtx {
  return useContext(Ctx) ?? EMPTY;
}
