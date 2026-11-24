// Browser side of stage 2 commands: assigns a reqId, sends, resolves when the matching ack arrives.
import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import type { AckNext, ClientMsgNext, ServerMsgNext } from './protocolNext';

export interface CommandResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  linkId?: string; // link_create
  machineId?: string; // machine_add
  answer?: string; // summary assistant reply
}

type Distribute<T> = T extends unknown ? Omit<T, 'reqId'> : never;
/** `machineId` on a routable command sends it to that machine's agent (see REMOTE_ROUTABLE in shared/protocol.ts). */
export type CommandInput = Distribute<ClientMsg | ClientMsgNext> & { machineId?: string };

export interface Commander {
  send(cmd: CommandInput, timeoutMs?: number): Promise<CommandResult>;
  /** Feed every server message; acks resolve their request. */
  onMessage(msg: ServerMsg | ServerMsgNext): void;
  /** Connection lost: everything still waiting fails. */
  failAll(error: string): void;
  pendingCount(): number;
}

export function createCommander(
  sendRaw: (text: string) => boolean,
  opts: { timeoutMs?: number; idPrefix?: string } = {},
): Commander {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const prefix = opts.idPrefix ?? 'w';
  const waiting = new Map<string, { resolve: (r: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>();
  let n = 0;
  return {
    send(cmd, perCallTimeoutMs) {
      const reqId = `${prefix}${Date.now().toString(36)}-${++n}`;
      return new Promise<CommandResult>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(reqId);
          resolve({ ok: false, error: 'เซิร์ฟเวอร์ไม่ตอบ' });
        }, perCallTimeoutMs ?? (cmd.type === 'takeover' ? 60_000 : timeoutMs)); // takeover: kill + wait + adopt, maybe over ssh
        waiting.set(reqId, { resolve, timer });
        const sent = sendRaw(JSON.stringify({ ...cmd, reqId }));
        if (!sent) {
          clearTimeout(timer);
          waiting.delete(reqId);
          resolve({ ok: false, error: 'ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์' });
        }
      });
    },
    onMessage(msg) {
      if (msg.type !== 'ack') return;
      const w = waiting.get(msg.reqId);
      if (!w) return;
      clearTimeout(w.timer);
      waiting.delete(msg.reqId);
      w.resolve({ ok: msg.ok, error: msg.error, sessionId: msg.sessionId, linkId: msg.linkId, machineId: (msg as typeof msg & AckNext).machineId, answer: msg.answer });
    },
    failAll(error) {
      for (const [id, w] of waiting) {
        clearTimeout(w.timer);
        w.resolve({ ok: false, error });
        waiting.delete(id);
      }
    },
    pendingCount: () => waiting.size,
  };
}
