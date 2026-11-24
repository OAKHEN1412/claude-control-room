// Add / edit form of a remote machine (used by the "+ เครื่อง" popover and the machine drawer).
import { useState } from 'react';
import type { TailscalePeer } from '../protocolNext';
import { KEY_HINT, NAME_MAX, SHELLS, applyPeer, validateMachine, type MachineForm } from '../machineForm';

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
          <span>เลือกจากเครื่องใน Tailscale</span>
          <select
            className="cc-sel"
            value=""
            onChange={(e) => {
              const p = peers.find((x) => x.name === e.target.value);
              if (p) setF((cur) => applyPeer(cur, p));
            }}
          >
            <option value="">{peers.length === 0 ? 'ไม่พบเครื่องใน Tailscale — พิมพ์เองได้' : '— เลือกเพื่อกรอกชื่อและที่อยู่ให้ —'}</option>
            {peers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {p.ip} · {p.os}
                {p.online ? '' : ' (ออฟไลน์)'}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="cv-field-row">
        <label className="cv-field" style={{ flex: '1 1 140px' }}>
          <span>ชื่อเครื่อง</span>
          <input className="cc-input" value={f.name} maxLength={NAME_MAX + 10} aria-invalid={!!show('name')} onChange={(e) => set('name', e.target.value)} onBlur={() => touch('name')} />
          {show('name') && <em className="cv-field-err">{show('name')}</em>}
        </label>
        <label className="cv-field" style={{ flex: '1 1 140px' }}>
          <span>ที่อยู่ (host / IP)</span>
          <input className="cc-input" value={f.host} spellCheck={false} aria-invalid={!!show('host')} onChange={(e) => set('host', e.target.value)} onBlur={() => touch('host')} />
          {show('host') && <em className="cv-field-err">{show('host')}</em>}
        </label>
      </div>
      <div className="cv-field-row">
        <label className="cv-field" style={{ flex: '1 1 120px' }}>
          <span>ผู้ใช้ SSH</span>
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
        <span>ไฟล์คีย์ SSH</span>
        <input className="cc-input" value={f.keyPath} placeholder="~/.ssh/id_ed25519" spellCheck={false} aria-invalid={!!show('keyPath')} onChange={(e) => set('keyPath', e.target.value)} onBlur={() => touch('keyPath')} />
        {show('keyPath') ? <em className="cv-field-err">{show('keyPath')}</em> : <em className="cv-field-hint">{KEY_HINT} (เว้นว่างได้ ตั้งค่าทีหลัง)</em>}
      </label>
      <label className="cv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={f.agent === true} onChange={(e) => setF((cur) => ({ ...cur, agent: e.target.checked }))} />
        <span>ดู Claude บนเครื่องนี้ (ต้องติดตั้ง agent ก่อน)</span>
      </label>
      <label className="cv-field">
        <span>บันทึก</span>
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
          ยกเลิก
        </button>
        <button type="submit" className="cc-btn is-primary" disabled={busy || !valid}>
          {busy ? 'กำลังบันทึก…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
