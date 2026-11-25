// Usage / rate limit view helpers. Pure; the server decides what a limit is (SessionInfo.limit / RunnerState.limit).
import { limitLabelMsg, type LimitInfo, type RunnerState, type SessionInfo } from '../../shared/protocol';
import { serverCode } from './i18n/serverMsg';

/** The limit a session shows: its transcript's own, else the one the Runner saw on the stream. */
export function limitOf(session: Pick<SessionInfo, 'limit'> | null | undefined, runner?: Pick<RunnerState, 'limit'> | null): LimitInfo | null {
  return session?.limit ?? runner?.limit ?? null;
}

/** Short red label, e.g. "ติดลิมิต · resets 1:30pm (Asia/Bangkok)"; null when not limited. */
export function limitText(session: Pick<SessionInfo, 'limit'> | null | undefined, runner?: Pick<RunnerState, 'limit'> | null): string | null {
  const l = limitOf(session, runner);
  if (!l) return null;
  const m = limitLabelMsg(l.text);
  return serverCode(m.code, m.vars, m.text);
}
