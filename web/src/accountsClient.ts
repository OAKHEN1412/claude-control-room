// Typed fetch wrappers for the account API (server/src/accountsApi.ts).
// Every call resolves to {ok:true, ...fields} or {ok:false, error: CODE}; it never throws.
// error is the API code from the body, 'NETWORK' when the request did not reach the server, or 'SERVER_ERROR'
// when the reply was not a usable JSON body. A token is sent only in the PUT body of putToken, never in a URL,
// a log line or an error.
import type { AccountInfo, AccountsView, MainAccountInfo } from '../../shared/accounts';
import { apiBase } from './useServer';

export type AcctResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface ProfileInput {
  name: string;
  color?: string;
  letter?: string;
  note?: string;
}

export interface ProfilePatch {
  name?: string;
  color?: string;
  letter?: string;
  note?: string;
  hidden?: boolean;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function errorCode(body: unknown): string | null {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return null;
}

/**
 * bare = the reply is the payload itself (GET /api/accounts, GET /api/auth/state) and carries no ok field.
 * Exported for the other web API clients (authClient). Every call sends the cookie (credentials 'include').
 */
export async function request<T extends object>(
  method: string,
  path: string,
  body: unknown | undefined,
  f: Fetcher,
  bare = false,
): Promise<AcctResult<T>> {
  const init: RequestInit = { method, credentials: 'include' };
  if (body !== undefined) {
    init.headers = JSON_HEADERS;
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await f(`${apiBase()}${path}`, init);
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  const isObj = !!parsed && typeof parsed === 'object';
  const ok = res.ok && isObj && (bare || (parsed as { ok?: unknown }).ok === true);
  if (!ok) return { ok: false, error: errorCode(parsed) ?? 'SERVER_ERROR' };
  return { ...(parsed as T), ok: true };
}

const seg = (id: string): string => encodeURIComponent(id);

export function listAccounts(f: Fetcher = fetch): Promise<AcctResult<AccountsView>> {
  return request<AccountsView>('GET', '/api/accounts', undefined, f, true);
}

export function createAccount(input: ProfileInput, f: Fetcher = fetch): Promise<AcctResult<{ account: AccountInfo }>> {
  return request<{ account: AccountInfo }>('POST', '/api/accounts', input, f);
}

export function patchAccount(id: string, patch: ProfilePatch, f: Fetcher = fetch): Promise<AcctResult<{ account: AccountInfo }>> {
  return request<{ account: AccountInfo }>('PATCH', `/api/accounts/${seg(id)}`, patch, f);
}

export function deleteAccount(id: string, f: Fetcher = fetch): Promise<AcctResult> {
  return request('DELETE', `/api/accounts/${seg(id)}`, undefined, f);
}

export function setDefaultAccount(accountId: string, f: Fetcher = fetch): Promise<AcctResult<{ defaultId: string }>> {
  return request<{ defaultId: string }>('PUT', '/api/accounts/default', { accountId }, f);
}

/** Starts the browser login for a profile. The result is 202 with progress arriving on the account_connect message. */
export function connectAccount(id: string, f: Fetcher = fetch): Promise<AcctResult> {
  return request('POST', `/api/accounts/${seg(id)}/connect`, undefined, f);
}

export function cancelConnect(id: string, f: Fetcher = fetch): Promise<AcctResult<{ cancelled: boolean }>> {
  return request<{ cancelled: boolean }>('POST', `/api/accounts/${seg(id)}/connect/cancel`, undefined, f);
}

/** Saves a token. The token is in the request body only; the reply carries the profile, never the token. */
export function putToken(id: string, token: string, f: Fetcher = fetch): Promise<AcctResult<{ account: AccountInfo }>> {
  return request<{ account: AccountInfo }>('PUT', `/api/accounts/${seg(id)}/token`, { token }, f);
}

/** Asks the server to refresh a profile's usage now. The header ignores the reply: the ws `accounts` broadcast carries the update. */
export function refreshUsage(id: string, f: Fetcher = fetch): Promise<AcctResult<{ account: AccountInfo }>> {
  return request<{ account: AccountInfo }>('POST', `/api/accounts/${seg(id)}/refresh-usage`, undefined, f);
}

export function checkAccount(id: string, f: Fetcher = fetch): Promise<AcctResult<{ account: AccountInfo }>> {
  return request<{ account: AccountInfo }>('POST', `/api/accounts/${seg(id)}/check`, undefined, f);
}

// ---- main account (the terminal claude's own login) ----

/** Login state of the main account. fresh=true skips the server's 60 s cache. */
export function getMainAccount(fresh = false, f: Fetcher = fetch): Promise<AcctResult<MainAccountInfo>> {
  return request<MainAccountInfo>('GET', `/api/accounts/main${fresh ? '?fresh=1' : ''}`, undefined, f, true);
}

/** Starts the browser login of the main account. Progress arrives on the main_login message. */
export function startMainLogin(f: Fetcher = fetch): Promise<AcctResult> {
  return request('POST', '/api/accounts/main/login', undefined, f);
}

/** Sends the pasted login code. The code is in the request body only. */
export function sendMainLoginCode(code: string, f: Fetcher = fetch): Promise<AcctResult> {
  return request('POST', '/api/accounts/main/login/code', { code }, f);
}

export function cancelMainLogin(f: Fetcher = fetch): Promise<AcctResult<{ cancelled: boolean }>> {
  return request<{ cancelled: boolean }>('POST', '/api/accounts/main/login/cancel', undefined, f);
}

export function mainLogout(f: Fetcher = fetch): Promise<AcctResult<{ main: MainAccountInfo }>> {
  return request<{ main: MainAccountInfo }>('POST', '/api/accounts/main/logout', undefined, f);
}

// ---- token profile passwords ----

/** Unlocks a password-protected token profile for this server run. The password is in the request body only. */
export function unlockAccount(id: string, password: string, f: Fetcher = fetch): Promise<AcctResult<{ account: AccountInfo }>> {
  return request<{ account: AccountInfo }>('POST', `/api/accounts/${seg(id)}/unlock`, { password }, f);
}

/** Sets, changes or removes a profile's password. Passwords are in the request body only. */
export function setAccountPassword(
  id: string,
  input: { current?: string; next?: string },
  f: Fetcher = fetch,
): Promise<AcctResult<{ account: AccountInfo }>> {
  return request<{ account: AccountInfo }>('PUT', `/api/accounts/${seg(id)}/password`, input, f);
}
