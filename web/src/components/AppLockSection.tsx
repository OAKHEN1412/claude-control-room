import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useT, type TKey } from '../i18n';
import { getAuthState, lockApp, setAppPassword, type AuthState } from '../authClient';
import { errText } from '../accountsView';
import { formatCountdown, pinErrorKey } from '../pinLogic';
import { PinInput, useLockoutRemaining } from './PinInput';

type FormId = 'set' | 'change' | 'remove';

/**
 * App PIN ("PIN เข้าโปรแกรม"): a 6-digit PIN that locks the Control Room itself, not the terminal's Claude login.
 * Set = new PIN twice; change = current + new twice; remove = current. Each finished form submits by itself.
 * `initial` lets a static render show a known state without the mount-time fetch.
 */
export function AppLockSection(props: { initial?: AuthState | null }): ReactElement {
  const t = useT();
  const [auth, setAuth] = useState<AuthState | null>(props.initial ?? null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [wrongForm, setWrongForm] = useState<FormId | null>(null);
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const remaining = useLockoutRemaining(lockUntil);
  const locked = remaining > 0;

  const reload = async (): Promise<void> => {
    const r = await getAuthState();
    if (!r.ok) {
      setLoadErr(errText(r.error));
      return;
    }
    setLoadErr(null);
    setAuth({ required: r.required, unlocked: r.unlocked });
  };

  useEffect(() => {
    if (props.initial !== undefined) return;
    void reload();
    // reload is stable for the life of the page; the initial fetch runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = async (form: FormId, input: { current?: string; next?: string }): Promise<void> => {
    setBusy(true);
    setMsg(null);
    setWrongForm(null);
    const r = await setAppPassword(input);
    setBusy(false);
    setResetKey((k) => k + 1); // clears every box of every form
    if (!r.ok) {
      if (r.error === 'TOO_MANY_TRIES') {
        setLockUntil(Date.now() + (r.retryAfterMs ?? 30_000));
        return;
      }
      const key = pinErrorKey(r.error);
      if (key === 'acct.pin.err.wrong') setWrongForm(form);
      setMsg({ kind: 'err', text: key ? t(key as TKey) : errText(r.error) });
      return;
    }
    setMsg({ kind: 'ok', text: t('acct.applock.saved') });
    void reload();
  };

  const onLockNow = async (): Promise<void> => {
    setMsg(null);
    const r = await lockApp();
    if (!r.ok) {
      setMsg({ kind: 'err', text: errText(r.error) });
      return;
    }
    // The session cookie is gone; a reload shows the lock screen.
    window.location.reload();
  };

  const required = auth?.required ?? false;
  const disabled = busy || locked;
  const shared = {
    disabled,
    resetKey,
    mismatchText: t('acct.pin.mismatch'),
    onClearMsg: () => setMsg(null),
  };

  return (
    <section className="ap-applock" aria-labelledby="ap-applock-title">
      <div className="ap-applock-head">
        <h2 id="ap-applock-title" className="ap-applock-title">
          {t('acct.applock.title')}
        </h2>
        {auth && (
          <span className={required ? 'ap-badge ap-badge-set' : 'ap-badge'}>
            {required ? t('acct.applock.on') : t('acct.applock.off')}
          </span>
        )}
      </div>
      <p className="ap-note">{t('acct.applock.desc')}</p>

      {loadErr && (
        <p className="ap-err-inline" role="alert">
          {t('acct.applock.loadFailed')}: {loadErr}
        </p>
      )}
      {!auth && !loadErr && <p className="ap-muted">{t('acct.applock.loading')}</p>}

      {auth && !required && (
        <PinForm
          {...shared}
          title={t('acct.applock.setTitle')}
          rows={[
            { key: 'new', label: t('acct.pin.new') },
            { key: 'confirm', label: t('acct.pin.confirm') },
          ]}
          focusOnMount
          error={wrongForm === 'set'}
          mismatchCheck={(v) => v[0] !== v[1]}
          onDone={(v) => void onSubmit('set', { next: v[0] })}
        />
      )}

      {auth && required && (
        <div className="ap-pw-forms">
          <PinForm
            {...shared}
            title={t('acct.applock.changeTitle')}
            rows={[
              { key: 'current', label: t('acct.pin.current') },
              { key: 'new', label: t('acct.pin.new') },
              { key: 'confirm', label: t('acct.pin.confirm') },
            ]}
            focusOnMount
            error={wrongForm === 'change'}
            mismatchCheck={(v) => v[1] !== v[2]}
            onDone={(v) => void onSubmit('change', { current: v[0], next: v[1] })}
          />
          <PinForm
            {...shared}
            title={t('acct.applock.removeTitle')}
            rows={[{ key: 'current', label: t('acct.pin.current') }]}
            error={wrongForm === 'remove'}
            onDone={(v) => void onSubmit('remove', { current: v[0] })}
          />
          <button type="button" className="cc-btn" onClick={() => void onLockNow()}>
            {t('acct.applock.lockNow')}
          </button>
        </div>
      )}

      {locked && (
        <p className="ap-err-inline" role="status">
          {t('acct.pin.countdown', { time: formatCountdown(remaining) })}
        </p>
      )}
      {msg && !locked && (
        <p className={msg.kind === 'err' ? 'ap-err-inline' : 'ap-muted'} role={msg.kind === 'err' ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}

      <div className="ap-applock-notes">
        <p className="ap-muted">{t('acct.applock.noteScope')}</p>
        <p className="ap-muted">{t('acct.applock.noteReset')}</p>
      </div>
    </section>
  );
}

interface PinFormProps {
  title: string;
  rows: { key: string; label: string }[];
  disabled: boolean;
  error: boolean;
  resetKey: number;
  mismatchText: string;
  onClearMsg(): void;
  /** Called with the PIN of every row once the last row is complete (and the rows agree). */
  onDone(values: string[]): void;
  /** True when the entered rows disagree: the form starts over with a message instead of submitting. */
  mismatchCheck?(values: string[]): boolean;
  /** Focus the first row when the form first appears. Off by default, so a form never grabs focus by itself. */
  focusOnMount?: boolean;
}

/**
 * One PIN form: the rows fill in order (the next row takes the focus when the one before it is complete).
 * The last row's completion submits. A mismatch clears the rows locally; a finished call clears them via resetKey.
 */
function PinForm(props: PinFormProps): ReactElement {
  const [phase, setPhase] = useState(0);
  // Focus follows the user: true only once they have typed in this form (or it was asked to focus on mount).
  const [engaged, setEngaged] = useState(props.focusOnMount ?? false);
  const [mismatch, setMismatch] = useState(false);
  const [localReset, setLocalReset] = useState(0);
  const values = useRef<string[]>([]);
  const seenReset = useRef(props.resetKey);
  const last = props.rows.length - 1;

  // A finished call (resetKey bumped by the parent) starts the form again at the first row, without focus.
  useEffect(() => {
    if (seenReset.current === props.resetKey) return;
    seenReset.current = props.resetKey;
    values.current = [];
    setPhase(0);
    setEngaged(false);
  }, [props.resetKey]);

  const onRowComplete = (i: number, pin: string): void => {
    setEngaged(true);
    values.current[i] = pin;
    if (i < last) {
      setPhase(i + 1);
      return;
    }
    const all = [...values.current];
    if (props.mismatchCheck?.(all)) {
      setMismatch(true);
      values.current = [];
      setLocalReset((n) => n + 1);
      setPhase(0);
      return;
    }
    props.onDone(all);
  };

  return (
    <form className="ap-form" aria-label={props.title} onSubmit={(e) => e.preventDefault()}>
      <h3 className="ap-form-title">{props.title}</h3>
      {props.rows.map((row, i) => (
        <div className="ap-pin-row" key={row.key}>
          <span className="ap-pin-label">{row.label}</span>
          <PinInput
            label={row.label}
            autoFocus={engaged && phase === i}
            disabled={props.disabled}
            error={props.error}
            resetKey={props.resetKey + localReset}
            onChange={() => {
              setMismatch(false);
              props.onClearMsg();
            }}
            onComplete={(pin) => onRowComplete(i, pin)}
          />
        </div>
      ))}
      {mismatch && (
        <p className="ap-err-inline" role="alert">
          {props.mismatchText}
        </p>
      )}
    </form>
  );
}
