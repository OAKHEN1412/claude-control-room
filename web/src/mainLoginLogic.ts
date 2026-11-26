// Pure logic for the main-account login UI (MainLoginPanel, MainLoginGate). No React, no I/O.
import { TERMINAL_ACCOUNT_ID, validateLoginCode, type AccountInfo, type MainLoginEvent } from '../../shared/accounts';
import { isSafeUrl } from './accountDialogLogic';

export { isSafeUrl };

/** Hosts a main-account sign-in link may point at (the server enforces this too; the UI checks again). */
const LOGIN_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'] as const;

/**
 * The gate shows only when the builtin terminal profile carries main info and main says not logged in.
 * An old server (no `main` field) gives false, so the gate never blocks an app that cannot report the state.
 */
export function gateVisible(accounts: readonly AccountInfo[]): boolean {
  const terminal = accounts.find((a) => a.id === TERMINAL_ACCOUNT_ID);
  return terminal?.main?.loggedIn === false;
}

/**
 * The login event the UI may act on. `initial` is the event present when the component mounted: it is stale
 * (e.g. an old 'success' from an earlier login), so it is treated as null until a different event object arrives.
 */
export function viewOf(event: MainLoginEvent | null | undefined, initial: MainLoginEvent | null | undefined): MainLoginEvent | null {
  if (!event || event === initial) return null;
  return event;
}

/** A pasted code is valid when validateLoginCode accepts it (trimmed, 1..512 chars, no control characters). */
export function codeOk(code: unknown): boolean {
  return validateLoginCode(code) !== null;
}

/** Link to the browser approval page: https on claude.ai, claude.com or anthropic.com (or a subdomain of them). */
export function loginUrlOk(url: unknown): boolean {
  if (!isSafeUrl(url)) return false;
  try {
    const host = new URL(url as string).hostname;
    return LOGIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** 'idle' when no login event belongs to this mount yet, else the login status. */
export type PanelKind = 'idle' | MainLoginEvent['status'];

export interface PanelView {
  kind: PanelKind;
  /** The approval link may be shown (waiting_browser, and the url is a safe login url). */
  showLink: boolean;
  /** The paste-code form is shown: the server asks for a code, or the browser approval is pending. */
  showCode: boolean;
  /** Start (or retry) button is offered. */
  canStart: boolean;
  /** The button is a retry (the last attempt ended without success). */
  isRetry: boolean;
  /** Cancel is offered while the sign-in is running. */
  canCancel: boolean;
}

/** Maps the live login event (already filtered by viewOf) to what the panel shows. */
export function panelView(event: MainLoginEvent | null): PanelView {
  const kind: PanelKind = event ? event.status : 'idle';
  const retry = kind === 'failed' || kind === 'timeout' || kind === 'cancelled';
  return {
    kind,
    showLink: kind === 'waiting_browser' && loginUrlOk(event?.url),
    showCode: event?.needCode === true || kind === 'waiting_browser',
    canStart: kind === 'idle' || retry,
    isRetry: retry,
    canCancel: kind === 'starting' || kind === 'waiting_browser',
  };
}
