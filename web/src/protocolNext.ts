// Round-3 protocol names (saved sessions, machines). The server side is merged, so every type here is now
// derived from shared/protocol.ts — the single source of truth. Kept as a thin alias module so the UI code
// that imports from here does not need touching.
import type { ClientMsg, ServerMsg } from '../../shared/protocol';

export type { MachineAttachment, MachineInfo, MachineShell, SavedSession, TailscalePeer } from '../../shared/protocol';

type Snapshot = Extract<ServerMsg, { type: 'snapshot' }>;
type Ack = Extract<ServerMsg, { type: 'ack' }>;

/** Server messages added in round 3. */
export type ServerMsgNext = Extract<ServerMsg, { type: 'saved' | 'machines' }>;

/** Optional snapshot fields added in round 3. */
export type SnapshotNext = Pick<Snapshot, 'saved' | 'machines' | 'attachments' | 'peers'>;

/** The ack's optional machineId. */
export type AckNext = Pick<Ack, 'machineId'>;

/** Client messages added in round 3. */
export type ClientMsgNext = Extract<
  ClientMsg,
  { type: 'saved_hide' | 'saved_unhide' | 'saved_resume' | 'machine_add' | 'machine_update' | 'machine_delete' | 'machine_test' | 'machine_attach' | 'machine_detach' }
>;
