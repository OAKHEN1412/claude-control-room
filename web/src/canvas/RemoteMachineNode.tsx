// A remote machine on the canvas: name, host, reachability dot and SSH badge. Click opens its drawer; wires from AI blocks drop here.
import { memo } from 'react';
import { REACH_WORD, SSH_WORD, agentLine, shortKeyPath } from '../machineForm';
import type { MachineInfo } from '../protocolNext';
import { ComputerIcon } from './icons';
import { machineKey, type MachinePlace } from './machineLayout';
import { Dot, reachTone, sshTone } from './MachineDrawer';

export interface RemoteMachineNodeProps {
  place: MachinePlace;
  machine: MachineInfo;
  selected: boolean;
  /** A wire being dragged is over this node. */
  hot: boolean;
}

export const RemoteMachineNode = memo(function RemoteMachineNode({ place, machine, selected, hot }: RemoteMachineNodeProps) {
  const { box } = place;
  const label = `เครื่อง ${machine.name} ${REACH_WORD[machine.reach]} ${SSH_WORD[machine.ssh]}`;
  return (
    <div
      className={`cv-node cv-rm${selected ? ' is-selected' : ''}${hot ? ' is-hot' : ''}`}
      data-node={machineKey(machine.id)}
      data-kind="rmachine"
      data-mid={machine.id}
      data-reach={machine.reach}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={label}
      title={`${machine.name} · ${machine.host}${machine.keyPath ? ` · ${shortKeyPath(machine.keyPath)}` : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <div className="cv-rm-card">
        <div className="cv-rm-top">
          <span className="cv-rm-icon">
            <ComputerIcon size={22} />
          </span>
          <span className="cv-rm-name">{machine.name}</span>
          <Dot tone={reachTone(machine.reach)} />
        </div>
        <div className="cv-rm-host">{machine.host}</div>
        <div className="cv-rm-badges">
          <span className={`cv-rm-badge is-${sshTone(machine.ssh)}`}>{SSH_WORD[machine.ssh]}</span>
          {machine.agent && (
            <span className={`cv-rm-badge is-${machine.agentState === 'online' ? 'ok' : machine.agentState === 'error' ? 'bad' : 'idle'}`} title={agentLine(machine)} data-agent={machine.agentState ?? 'connecting'}>
              {agentLine(machine)}
            </span>
          )}
        </div>
      </div>
      <span className="cv-rm-port" aria-hidden="true" />
    </div>
  );
});
