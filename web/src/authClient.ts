// Typed fetch wrappers for the app lock (server/src/authApi.ts). Same result convention as accountsClient:
// {ok:true, ...fields} or {ok:false, error: CODE}; never throws. The app lock is a 6-digit PIN; the PIN travels
// in request bodies only. A TOO_MANY_TRIES refusal also carries retryAfterMs (the lockout length, from the body).
import { request, type AcctResult } from './accountsClient';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface AuthState {
  required: boolean; // an app PIN is configured
  unlocked: boolean; // this browser holds a valid session (true when no PIN is configured)
}

/** A failed auth call; retryAfterMs is set only for TOO_MANY_TRIES. */
export type AuthErr = { ok: false; error: string; retryAfterMs?: number };
export type AuthResult<T = object> = ({ ok: true } & T) | AuthErr;

/**
 * Runs a request through the shared helper and keeps retryAfterMs from a TOO_MANY_TRIES body.
 * The fetcher is wrapped so the body is read (from a clone) before the shared helper consumes it.
 */
async function authRequest<T extends object>(
  method: string,
  path: string,
  body: unknown | undefined,
  f: Fetcher,
  bare = false,
): Promise<AuthResult<T>> {
  let retryAfterMs: number | undefined;
  const spy: Fetcher = async (url, init) => {
    const res = await f(url, init);
    if (res.status === 429) {
      try {
        const b = (await res.clone().json()) as { retryAfterMs?: unknown };
        if (typeof b?.retryAfterMs === 'number' && Number.isFinite(b.retryAfterMs)) retryAfterMs = Math.max(0, b.retryAfterMs);
      } catch {
        // no usable body: the error code alone is reported
      }
    }
    return res;
  };
  const r: AcctResult<T> = await request<T>(method, path, body, spy, bare);
  if (r.ok) return r;
  if (r.error === 'TOO_MANY_TRIES' && retryAfterMs !== undefined) return { ok: false, error: r.error, retryAfterMs };
  return { ok: false, error: r.error };
}

/** Whether the app lock is on and whether this browser is unlocked. GET /api/auth/state answers without a session. */
export function getAuthState(f: Fetcher = fetch): Promise<AuthResult<AuthState>> {
  return authRequest<AuthState>('GET', '/api/auth/state', undefined, f, true);
}

/** Unlocks the app for this browser with the 6-digit PIN (the server sets the session cookie). */
export function unlockApp(pin: string, f: Fetcher = fetch): Promise<AuthResult> {
  return authRequest('POST', '/api/auth/unlock', { password: pin }, f);
}

/** Ends this browser's session. */
export function lockApp(f: Fetcher = fetch): Promise<AuthResult> {
  return authRequest('POST', '/api/auth/lock', undefined, f);
}

/**
 * Sets (no current needed when none is configured), changes or removes the app PIN.
 * Failures come back as the error code: PIN_INVALID (wrong format), BAD_PASSWORD (wrong current PIN),
 * TOO_MANY_TRIES (with retryAfterMs). The caller maps the code to text.
 */
export function setAppPassword(input: { current?: string; next?: string }, f: Fetcher = fetch): Promise<AuthResult> {
  return authRequest('PUT', '/api/auth/password', input, f);
}
