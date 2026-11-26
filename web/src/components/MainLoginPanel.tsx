// Self-contained sign-in flow for the main account (the terminal claude's own login).
// Start -> browser approval (optional paste-code form) -> success / failed / timeout / cancelled with retry.
// The pasted code lives only in the input's DOM value: it is read once on submit and cleared at once, never in state.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { validateLoginCode, type MainLoginEvent } from '../../../shared/accounts';
import { cancelMainLogin, getMainAccount, sendMainLoginCode, startMainLogin } from '../accountsClient';
import { errText } from '../accountsView';
import { tx, useT } from '../i18n';
import { panelView, viewOf } from '../mainLoginLogic';
import './mainLogin.css';

/** Text for a server error code: the main-account message when there is one, else the general account text. */
function mainErr(code: string): string {
  const known = tx(`acct.main.err.${code}`);
  return known !== '' ? known : errText(code);
}

export function MainLoginPanel(props: {
  mainLogin: MainLoginEvent | null;
  ptyAvailable: boolean;
  onSuccess?(): void;
}): JSX.Element {
  const t = useT();
  // The event present at mount is stale: ignore it until a different event arrives.
  const initial = useRef(props.mainLogin).current;
  const live = viewOf(props.mainLogin, initial);
  const view = panelView(live);

  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const successSeen = useRef(false);
  const onSuccessRef = useRef(props.onSuccess);
  onSuccessRef.current = props.onSuccess;

  // A new event means the last HTTP error is no longer the current news.
  useEffect(() => {
    setError(null);
  }, [props.mainLogin]);

  // Success fires once per mount, however many success events arrive.
  useEffect(() => {
    if (view.kind !== 'success' || successSeen.current) return;
    successSeen.current = true;
    onSuccessRef.current?.();
  }, [view.kind]);

  const start = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await startMainLogin();
    setBusy(false);
    if (!r.ok) setError(mainErr(r.error));
  };

  const cancel = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await cancelMainLogin();
    setBusy(false);
    if (!r.ok) setError(mainErr(r.error));
  };

  const submitCode = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const input = codeRef.current;
    const raw = input ? input.value : '';
    if (input) input.value = ''; // cleared at once, whatever the outcome
    const code = validateLoginCode(raw);
    if (code === null) {
      setError(t('acct.main.code.invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    const r = await sendMainLoginCode(code);
    setBusy(false);
    if (!r.ok) setError(mainErr(r.error));
  };

  const recheck = async (): Promise<void> => {
    setChecking(true);
    setError(null);
    const r = await getMainAccount(true);
    setChecking(false);
    if (!r.ok) {
      setError(mainErr(r.error));
    } else if (r.loggedIn) {
      onSuccessRef.current?.();
    } else {
      setError(t('acct.main.notLoggedIn'));
    }
  };

  if (!props.ptyAvailable) {
    return (
      <section className="ml-panel" aria-live="polite">
        <p className="ml-text">{t('acct.main.noPty')}</p>
        <div className="ml-row">
          <button type="button" className="cc-btn is-primary" disabled={checking} onClick={() => void recheck()}>
            {t('acct.main.recheck')}
          </button>
        </div>
        {error && <p className="ml-error" role="alert">{error}</p>}
      </section>
    );
  }

  let status: JSX.Element | null = null;
  if (view.kind === 'starting') {
    status = <p className="ml-text">{t('acct.main.starting')}</p>;
  } else if (view.kind === 'waiting_browser') {
    status = (
      <div className="ml-text">
        <p>{t('acct.main.waiting')}</p>
        {view.showLink && live?.url && (
          <a className="ml-link" href={live.url} target="_blank" rel="noopener noreferrer">
            {t('acct.main.openLink')}
          </a>
        )}
      </div>
    );
  } else if (view.kind === 'success') {
    status = <p className="ml-ok">{t('acct.main.success')}</p>;
  } else if (view.kind === 'failed') {
    status = (
      <p className="ml-error">
        {t('acct.main.failed')}
        {live?.error ? ` — ${mainErr(live.error)}` : ''}
      </p>
    );
  } else if (view.kind === 'timeout') {
    status = <p className="ml-error">{t('acct.main.timeout')}</p>;
  } else if (view.kind === 'cancelled') {
    status = <p className="ml-text">{t('acct.main.cancelled')}</p>;
  }

  return (
    <section className="ml-panel" aria-live="polite">
      <div className="ml-row">
        {view.canStart && (
          <button type="button" className="cc-btn is-primary" disabled={busy} onClick={() => void start()}>
            {view.isRetry ? t('acct.main.retry') : t('acct.main.start')}
          </button>
        )}
        {view.canCancel && (
          <button type="button" className="cc-btn" disabled={busy} onClick={() => void cancel()}>
            {t('acct.main.cancel')}
          </button>
        )}
      </div>

      {status}

      {view.showCode && (
        <form className="ml-code" autoComplete="off" onSubmit={(e) => void submitCode(e)}>
          <label className="ml-field">
            <span className="ml-label">{t('acct.main.code.label')}</span>
            <input
              ref={codeRef}
              className="cc-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              name="main-login-code"
            />
          </label>
          <div className="ml-row">
            <button type="submit" className="cc-btn is-primary" disabled={busy}>
              {t('acct.main.code.submit')}
            </button>
          </div>
        </form>
      )}

      {error && <p className="ml-error" role="alert">{error}</p>}
    </section>
  );
}
