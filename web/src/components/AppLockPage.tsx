// Full-screen app lock page: the whole program is locked with a 6-digit PIN until this browser unlocks it.
// The PIN goes to unlockApp in the request body only; the boxes are cleared as soon as it is sent.
import { useState, type ReactElement } from 'react';
import { unlockApp } from '../authClient';
import { useT, type TKey } from '../i18n';
import { formatCountdown, pinErrorKey } from '../pinLogic';
import { errText } from '../accountsView';
import { PinInput, useLockoutRemaining } from './PinInput';
import './unlock.css';

export function AppLockPage(props: { onUnlocked(): void }): ReactElement {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const remaining = useLockoutRemaining(lockUntil);
  const locked = remaining > 0;

  const onComplete = async (pin: string): Promise<void> => {
    if (busy || locked) return;
    setBusy(true);
    setError(null);
    setWrong(false);
    const r = await unlockApp(pin); // the PIN is only in this call
    setBusy(false);
    setResetKey((k) => k + 1); // clear the boxes whatever the answer
    if (!r.ok) {
      if (r.error === 'TOO_MANY_TRIES') {
        setLockUntil(Date.now() + (r.retryAfterMs ?? 30_000));
        return;
      }
      const key = pinErrorKey(r.error);
      if (key) setWrong(r.error !== 'PIN_INVALID');
      setError(key ? t(key as TKey) : errText(r.error));
      return;
    }
    props.onUnlocked();
  };

  return (
    <div className="unlock-page">
      <div className="unlock-card">
        <h1 className="unlock-title">{t('acct.lock.app.title')}</h1>
        <p className="unlock-hint">{t('acct.lock.app.hint')}</p>
        <PinInput
          label={t('acct.pin.label')}
          className="pin-group--center"
          focusOnReset
          autoFocus
          disabled={busy || locked}
          error={wrong}
          resetKey={resetKey}
          onChange={() => {
            setWrong(false);
            setError(null);
          }}
          onComplete={(pin) => void onComplete(pin)}
        />
        {locked && <p className="unlock-countdown" role="status">{t('acct.pin.countdown', { time: formatCountdown(remaining) })}</p>}
        {error && !locked && <p className="setup-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
