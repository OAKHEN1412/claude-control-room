// Server errors that reach the web carry a stable code (srv.<area>.<thing>) and the values for its {name}
// placeholders. The Thai message stays the error text (fallback and old clients), so nothing changes for them.
import type { VarMap } from '../../shared/protocol';

export class CodedError extends Error {
  readonly srvCode?: string;
  readonly vars?: VarMap;
  constructor(message: string, srvCode?: string, vars?: VarMap) {
    super(message);
    this.srvCode = srvCode;
    this.vars = vars;
  }
}

/** The code fields for an ack or error body. Empty when `e` has no code, so existing payloads stay the same. */
export function codeOf(e: unknown): { code?: string; vars?: VarMap } {
  if (!(e instanceof CodedError) || e.srvCode === undefined) return {};
  return e.vars ? { code: e.srvCode, vars: e.vars } : { code: e.srvCode };
}
