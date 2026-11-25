import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  type EffortLevel,
} from '../../../shared/protocol';
import { PermissionModeField, RemoteToggle, type Command } from './Controls';
import { AttachButton, AttachChips, DropOverlay } from './AttachBar';
import { Composer } from './Composer';
import { useNewJobForm } from './useNewJobForm';
import type { MachineInfo } from '../protocolNext';
import { useT } from '../i18n';
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
  const t = useT();
  const f = useNewJobForm({ cwds, command, disabledReason, onStarted, machines });
  const { choices, cwd, model, effort, prompt, permMode, rc, canStart } = f;
  const error = f.error && !disabledReason ? f.error : null;
  const start = f.start;

  return (
    <section className="cn-panel" aria-label={t('panels.newJob.aria')} ref={f.att.bindHost}>
      <DropOverlay att={f.att} />
      {f.machineChoices.length > 0 && (
        <div className="cn-field" style={{ flex: '0 1 170px' }}>
          <label htmlFor="cn-machine">{t('panels.newJob.machine')}</label>
          <select id="cn-machine" className="cc-sel" value={f.machineId} onChange={(e) => f.setMachineId(e.target.value)}>
            <option value="">{t('panels.newJob.thisPc')}</option>
            {f.machineChoices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="cn-field" style={{ flex: '1 1 220px' }}>
        <label htmlFor="cn-cwd">{t('panels.newJob.folder')}</label>
        <select id="cn-cwd" className="cc-sel" value={cwd} onChange={(e) => f.setCwd(e.target.value)}>
          {choices.length === 0 && <option value="">{t('panels.newJob.noFolders')}</option>}
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="cn-field" style={{ flex: '0 1 230px' }}>
        <label htmlFor="cn-model">{t('panels.newJob.model')}</label>
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
        <label htmlFor="cn-mode">{t('panels.newJob.mode')}</label>
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
        <label htmlFor="cn-prompt">{t('panels.newJob.task')}</label>
        <Composer
          id="cn-prompt"
          value={prompt}
          placeholder={t('panels.newJob.placeholder')}
          onChange={f.setPrompt}
          onPaste={f.att.onPaste}
          onSubmit={() => void start()}
        />
      </div>
      <AttachButton att={f.att} />
      <button type="button" className="cc-btn is-primary" disabled={!canStart} title={disabledReason ?? undefined} onClick={() => void start()}>
        {t('panels.newJob.start')}
      </button>
      <button type="button" className="cc-btn" onClick={onClose}>
        {t('panels.newJob.close')}
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
