// Owns the account (profile) context and the ONE add dialog, ONE unlock dialog and the main-login gate for a page.
// The caller passes the ServerApi it already created with useServer(); this component opens no connection itself.
import { useCallback, useMemo, useReducer, type ReactNode } from 'react';
import type { ServerApi } from '../useServer';
import { AccountsProvider, type AccountsCtx } from '../accountsContext';
import { dialogsReducer, INITIAL_DIALOGS, setAccountOutcome, unlockAccountOf } from '../accountsHost';
import { AccountAddDialog } from './AccountAddDialog';
import { UnlockDialog } from './UnlockDialog';
import { MainLoginGate } from './MainLoginGate';

export function AccountsHost(props: { server: ServerApi; children?: ReactNode }) {
  const { server } = props;
  const [dialogs, dispatch] = useReducer(dialogsReducer, INITIAL_DIALOGS);

  const setAccount = useCallback(
    async (sessionId: string, accountId: string) =>
      setAccountOutcome(await server.command({ type: 'set_account', sessionId, accountId })),
    [server.command],
  );
  const openAddDialog = useCallback((accountId?: string) => dispatch({ type: 'openAdd', accountId }), []);
  const openUnlockDialog = useCallback(
    (accountId: string, then?: () => void) => dispatch({ type: 'openUnlock', accountId, then }),
    [],
  );

  const ctx: AccountsCtx = useMemo(
    () => ({
      accounts: server.accounts,
      defaultAccountId: server.defaultAccountId,
      ptyAvailable: server.ptyAvailable,
      connect: server.connect,
      mainLogin: server.mainLogin,
      usage: server.usage,
      setAccount,
      openAddDialog,
      openUnlockDialog,
    }),
    [server.accounts, server.defaultAccountId, server.ptyAvailable, server.connect, server.mainLogin, server.usage, setAccount, openAddDialog, openUnlockDialog],
  );

  const unlockAccount = unlockAccountOf(server.accounts, dialogs.unlock);

  return (
    <AccountsProvider value={ctx}>
      {props.children}
      <AccountAddDialog
        open={dialogs.addOpen}
        onClose={() => dispatch({ type: 'closeAdd' })}
        accountId={dialogs.addAccountId}
        accounts={server.accounts}
        ptyAvailable={server.ptyAvailable}
        connect={server.connect}
      />
      <UnlockDialog
        open={dialogs.unlock !== null}
        account={unlockAccount}
        onClose={() => dispatch({ type: 'closeUnlock' })}
        onUnlocked={() => dialogs.unlock?.then?.()}
      />
      <MainLoginGate accounts={server.accounts} mainLogin={server.mainLogin} ptyAvailable={server.ptyAvailable} />
    </AccountsProvider>
  );
}
