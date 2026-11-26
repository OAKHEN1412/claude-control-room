// Unlock dialog for a password-protected token profile. Opened from the account UI for a locked profile.
// The password goes to unlockAccount in the request body only; the field is cleared as soon as it is sent.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AccountInfo } from '../../../shared/accounts';
import { unlockAccount } from '../accountsClient';
import { useT } from '../i18n';
import { canSubmit, unlockErrorText } from '../unlockLogic';
import { AccountAvatar } from './AccountAvatar';
import './unlock.css';

export function UnlockDialog(props: {
  open: boolean;
  account: AccountInfo | null;
  onClose(): void;
  onUnlocked(): void;
}): ReactElement | null {
  // Mounted only while open, so every opening starts with an empty field and no error.
  if (!props.open || !props.account) return null;
  return <UnlockDialogBody account={props.account} onClose={props.onClose} onUnlocked={props.onUnlocked} />;
}

function UnlockDialogBody(props: { account: AccountInfo; onClose(): void; onUnlocked(): void }): ReactElement {
  const t = useT();
  const { account, onClose, onUnlocked } = props;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The field is disabled while the call runs, so a wrong password would leave focus nowhere: once the call ends
  // with an error, clear the field and put the focus back in it.
  useEffect(() => {
    if (!busy && error) {
      setPassword('');
      inputRef.current?.focus();
    }
  }, [busy, error]);

  // Escape closes. The ref keeps one listener while the close handler changes every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = async (): Promise<void> => {
    if (busy || !canSubmit(password)) return;
    const value = password;
    setPassword(''); // cleared at once, never kept in state after the call
    setBusy(true);
    setError(null);
    const r = await unlockAccount(account.id, value);
    setBusy(false);
    if (!r.ok) {
      setError(unlockErrorText(r.error));
      return;
    }
    onUnlocked();
    onClose();
  };

  return (
    <div className="setup-backdrop" onClick={onClose}>
      <div
        className="setup-modal unlock-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unlock-dlg-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="setup-head">
          <h2 id="unlock-dlg-title" className="setup-title">{t('acct.lock.dlg.title')}</h2>
          <button type="button" className="cc-btn" onClick={onClose}>{t('acct.lock.dlg.close')}</button>
        </div>
        <form
          className="unlock-body"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="unlock-who">
            <AccountAvatar account={account} size={40} />
            <div className="unlock-who-text">
              <strong className="unlock-name">{account.name}</strong>
              <span className="unlock-hint">{t('acct.lock.dlg.hint')}</span>
            </div>
          </div>
          <label className="setup-field unlock-field">
            <span className="setup-label">{t('acct.lock.password')}</span>
            <input
              ref={inputRef}
              className="cc-input"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="setup-error" role="alert">{error}</p>}
          <div className="unlock-actions">
            <button type="submit" className="cc-btn unlock-submit" disabled={busy || !canSubmit(password)}>
              {t('acct.lock.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
