import { useState, type FormEvent, type ReactNode } from 'react';
import type { AccountInfo } from '../../../shared/accounts';
import { useT, type TKey } from '../i18n';
import { useAccounts } from '../accountsContext';
import { setAccountPassword } from '../accountsClient';
import { errText } from '../accountsView';
import { checkChangeForm, checkRemoveForm, checkSetForm, pwErrorKey, type PwCheck } from '../passwordLogic';

/** Labelled password input. Real <label> so the field is reachable by name. */
export function PasswordField(props: {
  id: string;
  label: string;
  value: string;
  onChange(v: string): void;
  autoComplete?: 'new-password' | 'current-password';
  hint?: string;
}) {
  return (
    <div className="ap-field">
      <label className="ap-field-label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className="cc-input ap-input"
        type="password"
        autoComplete={props.autoComplete ?? 'new-password'}
        maxLength={256}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span className="ap-hint">{props.hint}</span>}
    </div>
  );
}

/** Maps a form check result to the translated message. */
export function formCheckText(c: PwCheck, t: (k: TKey) => string): string | null {
  if (c.ok) return null;
  return t(`acct.mng.pw.err.${c.error}` as TKey);
}

/** Per-profile password block: lock state plus set / change / remove / unlock. Shown inside the expanded row. */
export function PasswordSection(props: { account: AccountInfo }) {
  const t = useT();
  const { openUnlockDialog } = useAccounts();
  const a = props.account;
  const id = a.id;

  // Local, cleared after every call so passwords do not linger in the DOM state.
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const clearFields = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
  };

  const run = async (
    check: PwCheck,
    input: { current?: string; next?: string },
  ): Promise<void> => {
    if (!check.ok) {
      setMsg({ kind: 'err', text: formCheckText(check, t) ?? '' });
      return;
    }
    setBusy(true);
    setMsg(null);
    const r = await setAccountPassword(id, input);
    setBusy(false);
    clearFields();
    if (!r.ok) {
      const key = pwErrorKey(r.error);
      setMsg({ kind: 'err', text: key ? t(key as TKey) : errText(r.error) });
      return;
    }
    setMsg({ kind: 'ok', text: t('acct.mng.pw.saved') });
  };

  const onSet = (e: FormEvent) => {
    e.preventDefault();
    void run(checkSetForm(next, confirm), { next });
  };

  const onChange = (e: FormEvent) => {
    e.preventDefault();
    void run(checkChangeForm(current, next, confirm), { current, next });
  };

  const onRemove = (e: FormEvent) => {
    e.preventDefault();
    void run(checkRemoveForm(current), { current });
  };

  let body: ReactNode;
  if (a.locked) {
    body = (
      <div className="ap-pw-locked">
        <p className="ap-note">{t('acct.mng.pw.lockedNote')}</p>
        <button type="button" className="cc-btn" onClick={() => openUnlockDialog(id)}>
          {t('acct.mng.pw.unlock')}
        </button>
      </div>
    );
  } else if (!a.hasPassword) {
    body = (
      <form className="ap-form" onSubmit={onSet} aria-label={t('acct.mng.pw.set')}>
        <PasswordField id={`pw-${id}-new`} label={t('acct.mng.pw.newLabel')} value={next} onChange={setNext} hint={t('acct.mng.pw.hint')} />
        <PasswordField id={`pw-${id}-confirm`} label={t('acct.mng.pw.confirmLabel')} value={confirm} onChange={setConfirm} />
        <button type="submit" className="cc-btn" disabled={busy}>
          {t('acct.mng.pw.set')}
        </button>
      </form>
    );
  } else {
    body = (
      <div className="ap-pw-forms">
        <form className="ap-form" onSubmit={onChange} aria-label={t('acct.mng.pw.change')}>
          <PasswordField id={`pw-${id}-cur`} label={t('acct.mng.pw.currentLabel')} value={current} onChange={setCurrent} autoComplete="current-password" />
          <PasswordField id={`pw-${id}-new`} label={t('acct.mng.pw.newLabel')} value={next} onChange={setNext} hint={t('acct.mng.pw.hint')} />
          <PasswordField id={`pw-${id}-confirm`} label={t('acct.mng.pw.confirmLabel')} value={confirm} onChange={setConfirm} />
          <button type="submit" className="cc-btn" disabled={busy}>
            {t('acct.mng.pw.change')}
          </button>
        </form>
        <form className="ap-form" onSubmit={onRemove} aria-label={t('acct.mng.pw.remove')}>
          <PasswordField id={`pw-${id}-rm`} label={t('acct.mng.pw.currentLabel')} value={current} onChange={setCurrent} autoComplete="current-password" />
          <button type="submit" className="cc-btn ap-danger" disabled={busy}>
            {t('acct.mng.pw.remove')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <section className="ap-pw" aria-label={t('acct.mng.pw.title')}>
      <div className="ap-pw-head">
        <span className="ap-pw-title">{t('acct.mng.pw.title')}</span>
        <LockBadge locked={a.locked} hasPassword={a.hasPassword} t={t} />
      </div>
      {body}
      {msg && (
        <p className={msg.kind === 'err' ? 'ap-err-inline' : 'ap-muted'} role={msg.kind === 'err' ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}
      <p className="ap-muted">{t('acct.mng.pw.forgot')}</p>
    </section>
  );
}

/** Lock badge with a lock glyph (inline SVG, decorative). */
export function LockBadge(props: { locked: boolean; hasPassword: boolean; t: (k: TKey) => string }) {
  const label = props.locked
    ? props.t('acct.mng.pw.badgeLocked')
    : props.hasPassword
      ? props.t('acct.mng.pw.badgeSet')
      : props.t('acct.mng.pw.badgeNone');
  const cls = props.locked ? 'ap-badge ap-badge-locked' : props.hasPassword ? 'ap-badge ap-badge-set' : 'ap-badge';
  return (
    <span className={cls}>
      {props.hasPassword && (
        <svg className="ap-lock-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
          <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      )}
      {label}
    </span>
  );
}
