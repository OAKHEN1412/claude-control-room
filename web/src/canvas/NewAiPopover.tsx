// "+ AI": a compact new-job popover over the canvas toolbar. Same fields and checks as the v1 panel (useNewJobForm).
import { EFFORT_LEVELS, MODEL_OPTIONS, type EffortLevel } from '../../../shared/protocol';
import { PermissionModeField, type Command } from '../components/Controls';
import { AttachButton, AttachChips, DropOverlay } from '../components/AttachBar';
import { Composer } from '../components/Composer';
import { useNewJobForm } from '../components/useNewJobForm';
import type { MachineInfo } from '../protocolNext';
import { useT, t as tr } from '../i18n';
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

// Resolved when called, not at module load, so the message follows the current language.
const offline: Command = () => Promise.resolve({ ok: false, error: tr('machine.ai.offline') });

export function NewAiPopover({ cwds, command, disabledReason, onStarted, onClose, machines }: NewAiPopoverProps) {
  const t = useT();
  const f = useNewJobForm({ cwds, command: command ?? offline, disabledReason: disabledReason ?? (command ? null : t('machine.ai.offline')), onStarted, machines });
  return (
    <section className="cv-pop cv-pop--ai cv-chrome" data-chrome="1" role="dialog" aria-label={t('machine.ai.title')} ref={f.att.bindHost} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <DropOverlay att={f.att} />
      <header className="cv-pop-head">
        <span className="cv-pop-title">{t('machine.ai.title')}</span>
        <button type="button" className="cv-pane-x" aria-label={t('machine.ai.close')} title={t('machine.ai.closeEsc')} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="cv-form">
        {f.machineChoices.length > 0 && (
          <label className="cv-field">
            <span>{t('machine.ai.runOn')}</span>
            <select className="cc-sel" value={f.machineId} onChange={(e) => f.setMachineId(e.target.value)} aria-label={t('machine.ai.machineAria')}>
              <option value="">{t('machine.ai.thisMachine')}</option>
              {f.machineChoices.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="cv-field">
          <span>{t('machine.ai.folder')}</span>
          <select className="cc-sel" value={f.cwd} onChange={(e) => f.setCwd(e.target.value)} autoFocus>
            {f.choices.length === 0 && <option value="">{t('machine.ai.noFolders')}</option>}
            {f.choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div className="cv-field-row">
          <label className="cv-field" style={{ flex: '1 1 150px' }}>
            <span>{t('machine.ai.model')}</span>
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
          <span>{t('machine.ai.mode')}</span>
          <PermissionModeField value={f.permMode} onCommit={f.commitMode} />
        </div>
        <label className="cv-field">
          <span>{t('machine.ai.prompt')}</span>
          <Composer
            submitOn="ctrl-enter"
            value={f.prompt}
            placeholder={t('machine.ai.placeholder')}
            onChange={f.setPrompt}
            onPaste={f.att.onPaste}
            onSubmit={() => void f.start()}
          />
        </label>
        <div className="cc-row">
          <AttachButton att={f.att} />
          <span className="cc-muted">{t('machine.ai.attachHint')}</span>
        </div>
        <AttachChips att={f.att} />
        {f.error && (
          <div className="cn-error" role="alert">
            {f.error}
          </div>
        )}
        <div className="cc-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="cc-btn" onClick={onClose}>
            {t('machine.ai.close')}
          </button>
          <button type="button" className="cc-btn is-primary" disabled={!f.canStart} title={f.disabledReason ?? undefined} onClick={() => void f.start()}>
            {f.working ? t('machine.ai.starting') : t('machine.ai.start')}
          </button>
        </div>
      </div>
    </section>
  );
}
