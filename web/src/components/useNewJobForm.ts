// State and validation of the "new job" form, shared by the v1 panel (NewJobPanel) and the v2 canvas popover (+ AI).
import { useEffect, useState } from 'react';
import { DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_PERMISSION_MODE, type EffortLevel, type PermissionMode } from '../../../shared/protocol';
import { cwdChoices, jobFlags } from '../control';
import type { MachineInfo } from '../protocolNext';
import { useCommand, type Command } from './Controls';
import { useAttachments } from './useAttachments';

export interface NewJobFormOptions {
  cwds: string[];
  command: Command;
  disabledReason: string | null; // e.g. offline / demo
  onStarted: (sessionId: string) => void;
  machines?: MachineInfo[]; // other PCs; connected agent machines are offered as the place to run the job
}

/** Machines a job can be started on: agent machines that are connected. */
export function remoteChoices(machines: readonly MachineInfo[] | undefined): MachineInfo[] {
  return (machines ?? []).filter((m) => m.agent === true && m.agentState === 'online');
}

export function useNewJobForm({ cwds, command, disabledReason, onStarted, machines }: NewJobFormOptions) {
  const [machineId, setMachineIdRaw] = useState(''); // '' = this PC
  const remote = remoteChoices(machines);
  // a machine that went offline falls back to this PC
  const target = remote.find((m) => m.id === machineId) ?? null;
  const choices = cwdChoices(target ? (target.agentCwds ?? []) : cwds);
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState<EffortLevel>(DEFAULT_EFFORT);
  const [prompt, setPrompt] = useState('');
  const [permMode, setPermMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);
  const [bypassOk, setBypassOk] = useState(false); // true only after the inline confirm
  const [rc, setRc] = useState(false);
  const { run, error, working } = useCommand(command);
  const att = useAttachments({ disabledReason });

  // Keep a valid folder selected as the server list arrives.
  const key = choices.join('|');
  useEffect(() => {
    setCwd((cur) => (choices.includes(cur) ? cur : (choices[0] ?? '')));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const canStart = !disabledReason && !working && cwd !== '' && !att.uploading && (prompt.trim() !== '' || att.ids.length > 0);
  const start = async () => {
    if (!canStart) return;
    const r = await run({ type: 'start', cwd, model, effort, prompt, ...(att.ids.length > 0 && !target ? { attachments: att.ids } : {}), ...jobFlags(permMode, bypassOk, rc), ...(target ? { machineId: target.id } : {}) });
    if (r.ok && r.sessionId) {
      setPrompt('');
      att.clear();
      onStarted(r.sessionId);
    }
  };

  return {
    machineChoices: remote,
    machineId: target ? target.id : '',
    setMachineId: (id: string) => {
      setMachineIdRaw(id);
      setCwd(''); // the folder list differs per machine
    },
    choices,
    cwd,
    setCwd,
    model,
    setModel,
    effort,
    setEffort,
    prompt,
    setPrompt,
    permMode,
    commitMode: (m: PermissionMode, confirmed: boolean) => {
      setPermMode(m);
      setBypassOk(confirmed);
    },
    rc,
    setRc,
    att,
    canStart,
    start,
    working,
    error: disabledReason ?? error,
    disabledReason,
  };
}
