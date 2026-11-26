// What the Runner needs from the account service: which profile a job runs as and its token.
// Types only; the implementation is AccountService (server/src/accounts.ts).

export interface AccountPort {
  /** Profile id for new jobs; TERMINAL_ACCOUNT_ID when none chosen. */
  defaultId(): string;
  /** Terminal + every row. */
  exists(id: string): boolean;
  /** Display name, falls back to the id. */
  nameOf(id: string): string;
  /**
   * null = no token injected (terminal profile). Throws CommandError code 'srv.account.noToken' when the profile
   * needs a token that is not loaded.
   */
  tokenFor(id: string): string | null;
  /** True when a token profile has a password and is not unlocked in this server run. Always false for the Terminal login. */
  isLocked(id: string): boolean;
  /** Remembered profile of a session (persisted). */
  sessionAccount(sessionId: string): string | null;
  /** Persist the profile a session runs as. */
  rememberSession(sessionId: string, accountId: string): void;
}
