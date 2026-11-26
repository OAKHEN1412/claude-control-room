// Add-profile dialog (2 steps): step 1 name / colour / letter / note creates the profile; step 2 connects it
// (browser login through the server pty) or takes a pasted token. Opened with accountId it skips step 1
// (reconnect or replace the token). A profile created here with no token is deleted again when the dialog closes.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AccountInfo, ConnectEvent } from '../../../shared/accounts';
import { ACCOUNT_COLORS, ACCOUNT_LETTER_MAX, ACCOUNT_NAME_MAX, ACCOUNT_NOTE_MAX } from '../../../shared/accounts';
import { cancelConnect, connectAccount, createAccount, deleteAccount, putToken } from '../accountsClient';
import { errText } from '../accountsView';
import { useT } from '../i18n';
import {
  canCancel,
  canProceed,
  canRetry,
  currentConnect,
  effectiveLetter,
  initialStep,
  isValidToken,
  nameLeft,
  nextStep,
  normalizeToken,
  pickDefaultColor,
  shouldCancelOnClose,
  shouldCleanupOnClose,
  statusView,
  toCreateInput,
  type DialogStep,
  type ProfileForm,
} from '../accountDialogLogic';
import { AccountAvatar } from './AccountAvatar';
import './accountDialog.css';
import './setup.css';

export function AccountAddDialog(props: {
  open: boolean;
  onClose(): void;
  accountId?: string;
  accounts: AccountInfo[];
  ptyAvailable: boolean;
  connect: ConnectEvent | null;
  onDone?(accountId: string): void;
}): JSX.Element | null {
  // Mounted only while open, so every opening starts with a fresh form.
  if (!props.open) return null;
  return <AddDialogBody {...props} />;
}

function AddDialogBody(props: Parameters<typeof AccountAddDialog>[0]): ReactElement {
  const t = useT();
  const { accounts, ptyAvailable, connect, onClose, onDone, accountId } = props;

  const [step, setStep] = useState<DialogStep>(initialStep(accountId !== undefined));
  const [form, setForm] = useState<ProfileForm>(() => ({
    name: '',
    color: pickDefaultColor(accounts),
    letter: '',
    letterEdited: false,
    note: '',
  }));
  // Profile created by this dialog (step 1). Stays null when the dialog was opened for an existing profile.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [tokenSaved, setTokenSaved] = useState<{ checkFailed: boolean } | null>(null);

  // The connect event present at mount is stale (an old connect's final event): ignore it until a new one arrives.
  const initialConnect = useRef(connect).current;
  const liveConnect = currentConnect(initialConnect, connect);

  const id = accountId ?? createdId;
  const view = statusView(liveConnect, id ?? '');
  const sawDone = useRef(false);
  const doneNotified = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Focus the first field when the dialog opens on step 1.
  useEffect(() => {
    if (step === 'form') nameRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Successful connect (or paste): tell the parent once. Also remember it, so close does not delete the profile.
  useEffect(() => {
    if (!id || doneNotified.current) return;
    const finished = view.kind === 'done' || tokenSaved !== null;
    if (!finished) return;
    sawDone.current = true;
    doneNotified.current = true;
    onDone?.(id);
  }, [id, view.kind, tokenSaved, onDone]);

  const handleClose = (): void => {
    if (createdId !== null) {
      const tokenState = accounts.find((a) => a.id === createdId)?.tokenState;
      if (shouldCleanupOnClose({ createdHere: true, tokenState, sawDone: sawDone.current })) {
        if (shouldCancelOnClose(view.kind)) void cancelConnect(createdId);
        void deleteAccount(createdId);
      }
    }
    onClose();
  };

  // Escape closes. The ref keeps one listener while the handler changes every render.
  const closeRef = useRef(handleClose);
  closeRef.current = handleClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submitForm = async (): Promise<void> => {
    if (busy || !canProceed(form)) return;
    setBusy(true);
    setError(null);
    const r = await createAccount(toCreateInput(form));
    setBusy(false);
    if (!r.ok) {
      setError(errText(r.error));
      return;
    }
    setCreatedId(r.account.id);
    setStep(nextStep(step, true));
  };

  const startConnect = async (): Promise<void> => {
    if (!id) return;
    setError(null);
    const r = await connectAccount(id);
    if (!r.ok) setError(errText(r.error));
  };

  const cancel = async (): Promise<void> => {
    if (!id) return;
    const r = await cancelConnect(id);
    if (!r.ok) setError(errText(r.error));
  };

  const savePaste = async (): Promise<void> => {
    if (!id || busy || !isValidToken(token)) return;
    const value = normalizeToken(token);
    setToken(''); // cleared at once, never kept in state after the call
    setBusy(true);
    setError(null);
    const r = await putToken(id, value);
    setBusy(false);
    if (!r.ok) {
      setError(errText(r.error));
      return;
    }
    setTokenSaved({ checkFailed: r.account.lastCheckOk === false });
  };

  const letter = effectiveLetter(form);
  const title = step === 'form' ? t('acct.dlg.title.add') : t('acct.dlg.title.connect');
  const statusLines = renderStatus();

  function renderStatus(): ReactElement | null {
    const lines: ReactElement[] = [];
    if (view.kind === 'waiting_browser') {
      lines.push(<p key="w">{t('acct.dlg.connect.waiting')}</p>);
      if (view.showLink && liveConnect?.url) {
        lines.push(
          <a key="l" className="acct-dlg-link" href={liveConnect?.url} target="_blank" rel="noopener noreferrer">
            {t('acct.dlg.connect.link')}
          </a>,
        );
      }
    } else if (view.kind === 'captured') {
      lines.push(<p key="c">{t('acct.dlg.connect.captured')}</p>);
    } else if (view.kind === 'checking') {
      lines.push(<p key="k">{t('acct.dlg.connect.checking')}</p>);
    } else if (view.kind === 'done') {
      lines.push(
        <p key="d" className="acct-dlg-row">
          <span className="acct-dlg-check" aria-hidden="true">✓</span>
          <span>{t('acct.dlg.connect.done')}</span>
        </p>,
      );
      if (view.checkFailed) lines.push(<p key="f" className="setup-error">{t('acct.dlg.connect.checkFailed')}</p>);
    } else if (view.kind === 'failed') {
      lines.push(<p key="x" className="setup-error">{errText(liveConnect?.error ?? 'SERVER_ERROR')}</p>);
    } else if (view.kind === 'timeout') {
      lines.push(<p key="o" className="setup-error">{t('acct.dlg.connect.timeout')}</p>);
    } else if (view.kind === 'cancelled') {
      lines.push(<p key="n">{t('acct.dlg.connect.cancelled')}</p>);
    }
    return lines.length > 0 ? <div className="acct-dlg-status" role="status" aria-live="polite">{lines}</div> : null;
  }

  return (
    <div className="setup-backdrop" onClick={handleClose}>
      <div
        className="setup-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="acct-dlg-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="setup-head">
          <h2 id="acct-dlg-title" className="setup-title">{title}</h2>
          <button type="button" className="cc-btn" onClick={handleClose}>{t('acct.dlg.close')}</button>
        </div>

        {step === 'form' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitForm();
            }}
          >
            <div className="acct-dlg-body">
              <div className="acct-dlg-preview">
                <AccountAvatar account={{ name: form.name.trim() || '?', color: form.color, letter }} size={56} />
                <span>{t('acct.dlg.preview')}</span>
              </div>

              <label className="setup-field acct-dlg-field">
                <span className="setup-label">{t('acct.dlg.name')}</span>
                <input
                  ref={nameRef}
                  className="cc-input"
                  value={form.name}
                  maxLength={ACCOUNT_NAME_MAX}
                  placeholder={t('acct.dlg.name.placeholder')}
                  autoComplete="off"
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
                <span className="setup-muted">{t('acct.dlg.name.left', { n: nameLeft(form.name) })}</span>
              </label>

              <div className="setup-field">
                <span className="setup-label" id="acct-dlg-color-label">{t('acct.dlg.color')}</span>
                <div className="acct-dlg-swatches" role="radiogroup" aria-labelledby="acct-dlg-color-label">
                  {ACCOUNT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={form.color === c}
                      aria-label={c}
                      className={`acct-dlg-swatch${form.color === c ? ' is-on' : ''}`}
                      style={{ background: c }}
                      onClick={() => setForm((f) => ({ ...f, color: c }))}
                    />
                  ))}
                </div>
              </div>

              <label className="setup-field acct-dlg-field">
                <span className="setup-label">{t('acct.dlg.letter')}</span>
                <input
                  className="cc-input"
                  value={letter}
                  maxLength={ACCOUNT_LETTER_MAX}
                  autoComplete="off"
                  onChange={(e) => setForm((f) => ({ ...f, letter: e.target.value, letterEdited: true }))}
                />
                <span className="setup-muted">{t('acct.dlg.letter.hint')}</span>
              </label>

              <label className="setup-field acct-dlg-field">
                <span className="setup-label">{t('acct.dlg.note')}</span>
                <input
                  className="cc-input"
                  value={form.note}
                  maxLength={ACCOUNT_NOTE_MAX}
                  placeholder={t('acct.dlg.note.placeholder')}
                  autoComplete="off"
                  onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                />
                <span className="setup-muted">{t('acct.dlg.note.hint')}</span>
              </label>

              {error && <p className="setup-error" role="alert">{error}</p>}
            </div>
            <div className="acct-dlg-foot">
              <button type="button" className="cc-btn" onClick={handleClose}>{t('acct.dlg.cancel')}</button>
              <button type="submit" className="cc-btn is-primary" disabled={busy || !canProceed(form)}>
                {t('acct.dlg.next')}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="acct-dlg-body">
              {ptyAvailable ? (
                <div className="acct-dlg-row">
                  {canRetry(view.kind) ? (
                    <button type="button" className="cc-btn is-primary" onClick={() => void startConnect()}>
                      {t('acct.dlg.connect.retry')}
                    </button>
                  ) : view.kind === 'idle' ? (
                    <button type="button" className="cc-btn is-primary" onClick={() => void startConnect()}>
                      {t('acct.dlg.connect.open')}
                    </button>
                  ) : null}
                  {canCancel(view.kind) && (
                    <button type="button" className="cc-btn" onClick={() => void cancel()}>
                      {t('acct.dlg.connect.cancelBtn')}
                    </button>
                  )}
                </div>
              ) : (
                <p className="setup-muted">{t('acct.dlg.connect.noPty')}</p>
              )}

              {statusLines}

              {error && <p className="setup-error" role="alert">{error}</p>}

              <details className="acct-dlg-paste" open={!ptyAvailable}>
                <summary>{t('acct.dlg.paste.summary')}</summary>
                <form
                  className="acct-dlg-paste-body"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void savePaste();
                  }}
                >
                  <label className="setup-field acct-dlg-field">
                    <span className="setup-label">{t('acct.dlg.paste.label')}</span>
                    <input
                      className="cc-input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                    />
                  </label>
                  {token.trim() !== '' && !isValidToken(token) && (
                    <p className="setup-muted">{t('acct.dlg.paste.invalid')}</p>
                  )}
                  <div className="acct-dlg-row">
                    <button type="submit" className="cc-btn" disabled={busy || !isValidToken(token) || !id}>
                      {t('acct.dlg.paste.save')}
                    </button>
                    {tokenSaved && (
                      <span className="setup-ok">{t('acct.dlg.paste.saved')}</span>
                    )}
                  </div>
                  {tokenSaved?.checkFailed && <p className="setup-error">{t('acct.dlg.connect.checkFailed')}</p>}
                </form>
              </details>
            </div>
            <div className="acct-dlg-foot">
              {(view.kind === 'done' || tokenSaved !== null) && (
                <button type="button" className="cc-btn is-primary" onClick={onClose}>
                  {t('acct.dlg.done')}
                </button>
              )}
              {!(view.kind === 'done' || tokenSaved !== null) && (
                <button type="button" className="cc-btn" onClick={handleClose}>
                  {t('acct.dlg.cancel')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
