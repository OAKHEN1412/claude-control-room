// "+ AI": a compact new-job popover over the canvas toolbar. Same fields and checks as the v1 panel (useNewJobForm).
import { EFFORT_LEVELS, MODEL_OPTIONS, type EffortLevel } from '../../../shared/protocol';
import { PermissionModeField, type Command } from '../components/Controls';
import { AttachButton, AttachChips, DropOverlay } from '../components/AttachBar';
import { useNewJobForm } from '../components/useNewJobForm';
import type { MachineInfo } from '../protocolNext';
import { CloseIcon } from './icons';
import '../components/control.css';

export interface NewAiPopoverProps {
  cwds: string[];
  machines?: MachineInfo[];
  command: Command | undefined;
  disabledReason: string | null;
  onStarted: (sessionId: string) => void;
  onClose: () => void;
}

const offline: Command = () => Promise.resolve({ ok: false, error: 'ยังสั่งงานไม่ได้' });

export function NewAiPopover({ cwds, command, disabledReason, onStarted, onClose, machines }: NewAiPopoverProps) {
  const f = useNewJobForm({ cwds, command: command ?? offline, disabledReason: disabledReason ?? (command ? null : 'ยังสั่งงานไม่ได้'), onStarted, machines });
  return (
    <section className="cv-pop cv-pop--ai cv-chrome" data-chrome="1" role="dialog" aria-label="เพิ่มงาน AI" ref={f.att.bindHost} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <DropOverlay att={f.att} />
      <header className="cv-pop-head">
        <span className="cv-pop-title">เพิ่มงาน AI</span>
        <button type="button" className="cv-pane-x" aria-label="ปิด" title="ปิด (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="cv-form">
        {f.machineChoices.length > 0 && (
          <label className="cv-field">
            <span>รันบนเครื่อง</span>
            <select className="cc-sel" value={f.machineId} onChange={(e) => f.setMachineId(e.target.value)} aria-label="เครื่องที่จะรันงาน">
              <option value="">เครื่องนี้</option>
              {f.machineChoices.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="cv-field">
          <span>โฟลเดอร์งาน</span>
          <select className="cc-sel" value={f.cwd} onChange={(e) => f.setCwd(e.target.value)} autoFocus>
            {f.choices.length === 0 && <option value="">ยังไม่มีโฟลเดอร์ที่รู้จัก</option>}
            {f.choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div className="cv-field-row">
          <label className="cv-field" style={{ flex: '1 1 150px' }}>
            <span>โมเดล</span>
            <select className="cc-sel" value={f.model} onChange={(e) => f.setModel(e.target.value)}>
              {MODEL_OPTIONS.map((o) => (
                <option key={o.id} value={o.id} disabled={!!o.disabled} title={o.disabled}>
                  {o.disabled ? `${o.label} (${o.disabled})` : o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="cv-field" style={{ flex: '0 1 96px' }}>
            <span>Effort</span>
            <select className="cc-sel" value={f.effort} onChange={(e) => f.setEffort(e.target.value as EffortLevel)}>
              {EFFORT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="cv-field">
          <span>โหมด</span>
          <PermissionModeField value={f.permMode} onCommit={f.commitMode} />
        </div>
        <label className="cv-field">
          <span>สั่งงาน</span>
          <textarea
            className="cc-input cv-prompt"
            rows={3}
            value={f.prompt}
            placeholder="พิมพ์งานที่จะให้ทำ (Ctrl+Enter เพื่อเริ่ม)"
            onChange={(e) => f.setPrompt(e.target.value)}
            onPaste={f.att.onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) void f.start();
            }}
          />
        </label>
        <div className="cc-row">
          <AttachButton att={f.att} />
          <span className="cc-muted">แนบไฟล์ · ลากไฟล์มาวาง · วางรูปด้วย Ctrl+V</span>
        </div>
        <AttachChips att={f.att} />
        {f.error && (
          <div className="cn-error" role="alert">
            {f.error}
          </div>
        )}
        <div className="cc-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="cc-btn" onClick={onClose}>
            ปิด
          </button>
          <button type="button" className="cc-btn is-primary" disabled={!f.canStart} title={f.disabledReason ?? undefined} onClick={() => void f.start()}>
            {f.working ? 'กำลังเริ่ม…' : 'เริ่มงาน'}
          </button>
        </div>
      </div>
    </section>
  );
}
