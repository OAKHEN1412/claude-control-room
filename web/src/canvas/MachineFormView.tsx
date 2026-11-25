// Add / edit form of a remote machine (used by the "+ เครื่อง" popover and the machine drawer).
import { useState } from 'react';
import type { TailscalePeer } from '../protocolNext';
import { useT } from '../i18n';
import { keyHint, NAME_MAX, SHELLS, applyPeer, validateMachine, type MachineForm } from '../machineForm';

export interface MachineFormViewProps {
  initial: MachineForm;
  /** Tailscale peers to pick from (add form only). */
  peers?: TailscalePeer[];
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (form: MachineForm) => void;
  onCancel: () => void;
}

export function MachineFormView({ initial, peers, submitLabel, busy, error, onSubmit, onCancel }: MachineFormViewProps) {
  const t = useT();
  const [f, setF] = useState<MachineForm>(initial);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const errors = validateMachine(f);
  const valid = Object.keys(errors).length === 0;
  const set = (k: keyof MachineForm, v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));
  const show = (k: keyof typeof errors) => (touched[k] || (f[k as keyof MachineForm] as string) !== '') && errors[k] ? errors[k] : null;

  return (
    <form
      className="cv-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) onSubmit(f);
        else setTouched({ name: true, host: true, user: true, keyPath: true, notes: true });
      }}
    >
      {peers && (
        <label className="cv-field">
          <span>{t('machine.formview.pickPeer')}</span>
          <select
            className="cc-sel"
            value=""
            onChange={(e) => {
              const p = peers.find((x) => x.name === e.target.value);
              if (p) setF((cur) => applyPeer(cur, p));
            }}
          >
            <option value="">{peers.length === 0 ? t('machine.formview.noPeers') : t('machine.formview.choosePeer')}</option>
            {peers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {p.ip} · {p.os}
                {p.online ? '' : t('machine.formview.offlineTag')}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="cv-field-row">
        <label className="cv-field" style={{ flex: '1 1 140px' }}>
          <span>{t('machine.formview.name')}</span>
          <input className="cc-input" value={f.name} maxLength={NAME_MAX + 10} aria-invalid={!!show('name')} onChange={(e) => set('name', e.target.value)} onBlur={() => touch('name')} />
          {show('name') && <em className="cv-field-err">{show('name')}</em>}
        </label>
        <label className="cv-field" style={{ flex: '1 1 140px' }}>
          <span>{t('machine.formview.host')}</span>
          <input className="cc-input" value={f.host} spellCheck={false} aria-invalid={!!show('host')} onChange={(e) => set('host', e.target.value)} onBlur={() => touch('host')} />
          {show('host') && <em className="cv-field-err">{show('host')}</em>}
        </label>
      </div>
      <div className="cv-field-row">
        <label className="cv-field" style={{ flex: '1 1 120px' }}>
          <span>{t('machine.formview.sshUser')}</span>
          <input className="cc-input" value={f.user} spellCheck={false} aria-invalid={!!show('user')} onChange={(e) => set('user', e.target.value)} onBlur={() => touch('user')} />
          {show('user') && <em className="cv-field-err">{show('user')}</em>}
        </label>
        <label className="cv-field" style={{ flex: '0 1 120px' }}>
          <span>Shell</span>
          <select className="cc-sel" value={f.shell} onChange={(e) => set('shell', e.target.value)}>
            {SHELLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="cv-field">
        <span>{t('machine.formview.keyFile')}</span>
        <input className="cc-input" value={f.keyPath} placeholder="~/.ssh/id_ed25519" spellCheck={false} aria-invalid={!!show('keyPath')} onChange={(e) => set('keyPath', e.target.value)} onBlur={() => touch('keyPath')} />
        {show('keyPath') ? <em className="cv-field-err">{show('keyPath')}</em> : <em className="cv-field-hint">{t('machine.formview.keyHint', { hint: keyHint() })}</em>}
      </label>
      <label className="cv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={f.agent === true} onChange={(e) => setF((cur) => ({ ...cur, agent: e.target.checked }))} />
        <span>{t('machine.formview.agentCheck')}</span>
      </label>
      <label className="cv-field">
        <span>{t('machine.formview.notes')}</span>
        <textarea className="cc-input cv-prompt" rows={2} value={f.notes} aria-invalid={!!show('notes')} onChange={(e) => set('notes', e.target.value)} />
        {show('notes') && <em className="cv-field-err">{show('notes')}</em>}
      </label>
      {error && (
        <div className="cn-error" role="alert">
          {error}
        </div>
      )}
      <div className="cc-row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="cc-btn" onClick={onCancel}>
          {t('machine.formview.cancel')}
        </button>
        <button type="submit" className="cc-btn is-primary" disabled={busy || !valid}>
          {busy ? t('machine.formview.saving') : submitLabel}
        </button>
      </div>
    </form>
  );
}
