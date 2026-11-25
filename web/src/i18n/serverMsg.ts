// Text the server sends to the UI. A server message carries a stable `code` (srv.<area>.<thing>) and `vars` for its
// {name} placeholders; `error` is the Thai text it also sends (the fallback, used when the code is unknown or missing).
import { tx, type Vars } from './index';

/** Translate a server code; returns `fallback` when the code is missing or unknown. */
export function serverCode(code: string | undefined | null, vars?: Vars, fallback = ''): string {
  return tx(code, vars, fallback);
}

/** Text for a server message object such as an ack, an error body or a status row. */
export function serverText(m: { error?: string; code?: string; vars?: Record<string, string | number> }): string {
  return tx(m.code, m.vars, m.error ?? '');
}
