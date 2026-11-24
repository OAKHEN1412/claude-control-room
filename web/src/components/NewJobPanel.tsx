import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  type EffortLevel,
} from '../../../shared/protocol';
import { PermissionModeField, RemoteToggle, type Command } from './Controls';
import { AttachButton, AttachChips, DropOverlay } from './AttachBar';
import { useNewJobForm } from './useNewJobForm';
import type { MachineInfo } from '../protocolNext';
import './control.css';

export interface NewJobPanelProps {
  cwds: string[];
  machines?: MachineInfo[];
  command: Command;
  disabledReason: string | null; // e.g. offline / demo
  onStarted: (sessionId: string) => void;
  onClose: () => void;
}

export function NewJobPanel({ cwds, command, disabledReason, onStarted, onClose, machines }: NewJobPanelProps) {
  const f = useNewJobForm({ cwds, command, disabledReason, onStarted, machines });
  const { choices, cwd, model, effort, prompt, permMode, rc, canStart } = f;
  const error = f.error && !disabledReason ? f.error : null;
  const start = f.start;

  return (
    <section className="cn-panel" aria-label="เปิดงานใหม่" ref={f.att.bindHost}>
      <DropOverlay att={f.att} />
      {f.machineChoices.length > 0 && (
        <div className="cn-field" style={{ flex: '0 1 170px' }}>
          <label htmlFor="cn-machine">รันบนเครื่อง</label>
          <select id="cn-machine" className="cc-sel" value={f.machineId} onChange={(e) => f.setMachineId(e.target.value)}>
            <option value="">เครื่องนี้</option>
            {f.machineChoices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="cn-field" style={{ flex: '1 1 220px' }}>
        <label htmlFor="cn-cwd">โฟลเดอร์งาน</label>
        <select id="cn-cwd" className="cc-sel" value={cwd} onChange={(e) => f.setCwd(e.target.value)}>
          {choices.length === 0 && <option value="">ยังไม่มีโฟลเดอร์ที่รู้จัก</option>}
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="cn-field" style={{ flex: '0 1 230px' }}>
        <label htmlFor="cn-model">โมเดล</label>
        <select id="cn-model" className="cc-sel" value={model} onChange={(e) => f.setModel(e.target.value)}>
          {MODEL_OPTIONS.map((o) => (
            <option key={o.id} value={o.id} disabled={!!o.disabled} title={o.disabled}>
              {o.disabled ? `${o.label} (${o.disabled})` : o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="cn-field" style={{ flex: '0 1 110px' }}>
        <label htmlFor="cn-effort">Effort</label>
        <select id="cn-effort" className="cc-sel" value={effort} onChange={(e) => f.setEffort(e.target.value as EffortLevel)}>
          {EFFORT_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="cn-field" style={{ flex: '0 1 230px' }}>
        <label htmlFor="cn-mode">โหมด</label>
        <PermissionModeField
          id="cn-mode"
          value={permMode}
          onCommit={f.commitMode}
        />
      </div>
      <div className="cn-field" style={{ flex: '0 0 auto' }}>
        <label htmlFor="cn-rc">Remote</label>
        <RemoteToggle id="cn-rc" on={rc} onChange={f.setRc} />
      </div>
      <div className="cn-field" style={{ flex: '3 1 280px' }}>
        <label htmlFor="cn-prompt">สั่งงาน</label>
        <input
          id="cn-prompt"
          className="cc-input"
          value={prompt}
          placeholder="พิมพ์งานที่จะให้ทำ"
          onChange={(e) => f.setPrompt(e.target.value)}
          onPaste={f.att.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void start();
          }}
        />
      </div>
      <AttachButton att={f.att} />
      <button type="button" className="cc-btn is-primary" disabled={!canStart} title={disabledReason ?? undefined} onClick={() => void start()}>
        เริ่ม
      </button>
      <button type="button" className="cc-btn" onClick={onClose}>
        ปิด
      </button>
      <div style={{ flex: '1 1 100%' }}>
        <AttachChips att={f.att} />
      </div>
      {(error || disabledReason) && (
        <div className="cn-error" role="alert">
          {disabledReason ?? error}
        </div>
      )}
    </section>
  );
}
