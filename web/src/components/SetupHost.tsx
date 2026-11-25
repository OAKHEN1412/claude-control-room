// Setup UI host: a floating gear button (bottom-left) opening a modal with two tabs, "Settings" and
// "Check this PC", plus the update banner at the top of the viewport. The modal opens on the Check tab once,
// on first run. The ElevenLabs key is write-only: the input is cleared after a save and only 'set'/'unset' is shown.
import { useEffect, useReducer, useState, type ReactNode } from 'react';
import './setup.css';
import {
  applyUpdate,
  busyReason,
  buildSettingsPatch,
  canUpdateReasonKey,
  cancelUpdate,
  checkHintKey,
  checkTitleKey,
  clearSecret,
  dismissVersion,
  draftFromConfig,
  fetchDoctor,
  fetchSettings,
  fetchUpdate,
  hasSeenSetup,
  isDismissed,
  isHttpsUrl,
  isValidKeyInput,
  keyStateKey,
  markSetupSeen,
  putSecret,
  refreshDoctor,
  saveSettings,
  statusClass,
  statusKey,
  updateNowDisabled,
  updateWhenIdleDisabled,
  UPDATE_POLL_MS,
  type DoctorReport,
  type SettingsDraft,
  type SettingsState,
  type UpdateState,
  type VoiceRow,
} from '../setupClient';
import { applyConfigLanguage, setLanguage, tx, useLang, useT } from '../i18n';

type Tab = 'settings' | 'doctor';

const VOICE_ID_RE = /^[A-Za-z0-9]{8,40}$/;
const VOICE_NAME_MAX = 80;

export function SetupHost() {
  const t = useT();

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('settings');
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // First run only: open the Check tab once.
  useEffect(() => {
    if (hasSeenSetup()) return;
    markSetupSeen();
    setTab('doctor');
    setOpen(true);
  }, []);

  // Server language: apply the config value once on load, even if the modal is never opened. Silent on failure.
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchSettings();
        if (r.ok) applyConfigLanguage(r.value.config.language);
      } catch {
        // offline or old server: keep the browser language
      }
    })();
  }, []);

  // Update status: every minute, and again when the tab regains focus.
  useEffect(() => {
    let alive = true;
    const load = () => {
      void fetchUpdate().then((r) => {
        if (alive && r.ok) setUpdate(r.value);
      });
    };
    load();
    const timer = setInterval(load, UPDATE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Escape closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const latest = update?.latest ?? null;
  const dismissed = latest ? isDismissed(latest.version) : true;
  const showBanner = !!update && update.available && !!latest && !dismissed;

  const applyNow = async (whenIdle: boolean) => {
    setActionMsg(null);
    const r = await applyUpdate(whenIdle);
    if (!r.ok) {
      setActionMsg(t('upd.error', { error: r.error }));
    }
    const fresh = await fetchUpdate();
    if (fresh.ok) setUpdate(fresh.value);
  };

  const cancel = async () => {
    setActionMsg(null);
    const r = await cancelUpdate();
    if (!r.ok) setActionMsg(t('upd.error', { error: r.error }));
    const fresh = await fetchUpdate();
    if (fresh.ok) setUpdate(fresh.value);
  };

  const dismiss = () => {
    if (latest) dismissVersion(latest.version);
    bump();
  };

  return (
    <>
      {showBanner && update && latest && (
        <UpdateBanner
          update={update}
          version={latest.version}
          notesUrl={latest.url}
          actionMsg={actionMsg}
          onNow={() => void applyNow(false)}
          onWhenIdle={() => void applyNow(true)}
          onCancel={() => void cancel()}
          onDismiss={dismiss}
        />
      )}

      <button type="button" className="setup-fab" aria-label={t('setup.fab.label')} title={t('setup.fab.label')} onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div className="setup-backdrop" onClick={() => setOpen(false)}>
          <div
            className="setup-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="setup-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="setup-head">
              <h2 id="setup-title" className="setup-title">
                {t('setup.modal.title')}
              </h2>
              <button type="button" className="cc-btn" onClick={() => setOpen(false)}>
                {t('setup.modal.close')}
              </button>
            </div>
            <div className="setup-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'settings'} className="setup-tab" onClick={() => setTab('settings')}>
                {t('setup.tab.settings')}
              </button>
              <button type="button" role="tab" aria-selected={tab === 'doctor'} className="setup-tab" onClick={() => setTab('doctor')}>
                {t('setup.tab.doctor')}
              </button>
            </div>
            <div className="setup-body" role="tabpanel">
              {tab === 'settings' ? <SettingsTab /> : <DoctorTab />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- update banner ----------

function UpdateBanner(props: {
  update: UpdateState;
  version: string;
  notesUrl: string;
  actionMsg: string | null;
  onNow: () => void;
  onWhenIdle: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const { update, version, notesUrl, actionMsg } = props;
  const busy = busyReason(update.busy);
  const nowOff = updateNowDisabled(update);
  const idleOff = updateWhenIdleDisabled(update);
  let reason: string | null = null;
  if (busy) reason = t(busy.key, { count: busy.count });
  else if (!update.canUpdate.ok) reason = t(canUpdateReasonKey(update.canUpdate.reason), { reason: update.canUpdate.reason ?? '' });

  return (
    <div className="setup-banner" role="status">
      <span className="setup-banner-text">{t('upd.banner.text', { version })}</span>
      {isHttpsUrl(notesUrl) && (
        <a className="setup-link" href={notesUrl} target="_blank" rel="noopener noreferrer">
          {t('upd.banner.notes')}
        </a>
      )}
      {update.scheduled ? (
        <>
          <span className="setup-banner-note">{t('upd.scheduled')}</span>
          <button type="button" className="cc-btn" onClick={props.onCancel}>
            {t('upd.cancel')}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="cc-btn is-primary" disabled={nowOff} onClick={props.onNow}>
            {t('upd.now')}
          </button>
          <button type="button" className="cc-btn" disabled={idleOff} onClick={props.onWhenIdle}>
            {t('upd.whenIdle')}
          </button>
        </>
      )}
      {update.applying && <span className="setup-banner-note">{t('upd.applying')}</span>}
      {reason && !update.applying && <span className="setup-banner-reason">{reason}</span>}
      {actionMsg && <span className="setup-banner-error">{actionMsg}</span>}
      <button type="button" className="cc-btn setup-banner-dismiss" onClick={props.onDismiss}>
        {t('upd.dismiss')}
      </button>
    </div>
  );
}

// ---------- settings tab ----------

function SettingsTab() {
  const t = useT();
  const [state, setState] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [voiceId, setVoiceId] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [voiceErr, setVoiceErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchSettings().then((r) => {
      if (!alive) return;
      if (r.ok) {
        setState(r.value);
        setDraft(draftFromConfig(r.value.config));
      } else {
        setLoadErr(r.error);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  if (loadErr) return <p className="setup-error">{t('setup.loadError', { message: loadErr })}</p>;
  if (!state || !draft) return <p className="setup-muted">{t('setup.loading')}</p>;

  const env = state.envOverrides;
  const set = (patch: Partial<SettingsDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = async () => {
    const patch = buildSettingsPatch(state.config, draft);
    if (Object.keys(patch).length === 0) {
      setMsg({ ok: true, text: t('set.noChanges') });
      return;
    }
    setSaving(true);
    setMsg(null);
    const r = await saveSettings(patch);
    setSaving(false);
    if (r.ok) {
      setState(r.value);
      setDraft(draftFromConfig(r.value.config));
      // An explicit Thai or English choice takes effect at once; 'auto' leaves the current language alone.
      const savedLang = r.value.config.language;
      if (patch.language !== undefined && (savedLang === 'th' || savedLang === 'en')) setLanguage(savedLang);
      setMsg({ ok: true, text: t('set.saved') });
    } else {
      setMsg({ ok: false, text: t('set.saveError', { error: r.error }) });
    }
  };

  const saveKey = async () => {
    if (!isValidKeyInput(keyInput)) {
      setKeyMsg({ ok: false, text: t('set.key.invalid') });
      return;
    }
    setKeyBusy(true);
    setKeyMsg(null);
    const r = await putSecret(keyInput.trim());
    setKeyBusy(false);
    setKeyInput('');
    if (r.ok) {
      setState((s) => (s ? { ...s, secrets: { elevenlabs: r.value } } : s));
      setKeyMsg({ ok: true, text: t('set.key.saved') });
    } else if (r.error === 'SECRETS_UNAVAILABLE') {
      setKeyMsg({ ok: false, text: t('set.key.unavailable') });
    } else {
      setKeyMsg({ ok: false, text: t('set.key.error', { error: r.error }) });
    }
  };

  const clearKey = async () => {
    setKeyBusy(true);
    setKeyMsg(null);
    const r = await clearSecret();
    setKeyBusy(false);
    setKeyInput('');
    if (r.ok) {
      setState((s) => (s ? { ...s, secrets: { elevenlabs: r.value } } : s));
      setKeyMsg({ ok: true, text: t('set.key.cleared') });
    } else if (r.error === 'SECRETS_UNAVAILABLE') {
      setKeyMsg({ ok: false, text: t('set.key.unavailable') });
    } else {
      setKeyMsg({ ok: false, text: t('set.key.error', { error: r.error }) });
    }
  };

  const addVoice = () => {
    const id = voiceId.trim();
    const name = voiceName.trim();
    if (!VOICE_ID_RE.test(id)) {
      setVoiceErr(t('set.voices.id'));
      return;
    }
    if (name === '' || name.length > VOICE_NAME_MAX) {
      setVoiceErr(t('set.voices.name'));
      return;
    }
    if (draft.voices.some((v) => v.id === id)) {
      setVoiceErr(t('set.voices.id'));
      return;
    }
    set({ voices: [...draft.voices, { id, name }] });
    setVoiceId('');
    setVoiceName('');
    setVoiceErr(null);
  };

  const removeVoice = (i: number) => set({ voices: draft.voices.filter((_, j) => j !== i) });

  const keyLabel = t(keyStateKey(state.secrets.elevenlabs));

  return (
    <div className="setup-settings">
      {state.warnings.length > 0 && (
        <div className="setup-warnings">
          <div className="setup-label">{t('set.warnings')}</div>
          <ul>
            {state.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <Field label={t('set.language')}>
        <select className="cc-sel" value={draft.language} onChange={(e) => set({ language: e.target.value as SettingsDraft['language'] })}>
          <option value="auto">{t('set.language.auto')}</option>
          <option value="th">{t('set.language.th')}</option>
          <option value="en">{t('set.language.en')}</option>
        </select>
      </Field>

      <label className="setup-check">
        <input type="checkbox" checked={draft.updateCheck} onChange={(e) => set({ updateCheck: e.target.checked })} />
        <span>{t('set.updateCheck')}</span>
      </label>

      <Field label={t('set.port')} note={env.port ? t('set.locked') : t('set.port.restart')}>
        <input
          className="cc-input"
          type="number"
          min={1}
          max={65535}
          disabled={env.port}
          value={draft.port ?? ''}
          onChange={(e) => set({ port: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </Field>

      <Field label={t('set.galleryRoots')} note={env.galleryRoots ? t('set.locked') : undefined}>
        <textarea
          className="cc-input setup-area"
          rows={3}
          disabled={env.galleryRoots}
          value={draft.galleryRootsText}
          onChange={(e) => set({ galleryRootsText: e.target.value })}
        />
      </Field>

      <Field label={t('set.videosDir')} note={env.videosDir ? t('set.locked') : undefined}>
        <input
          className="cc-input"
          type="text"
          disabled={env.videosDir}
          value={draft.videosDir}
          onChange={(e) => set({ videosDir: e.target.value })}
        />
      </Field>

      <Field label={t('set.extraCwds')} note={env.extraCwds ? t('set.locked') : undefined}>
        <textarea
          className="cc-input setup-area"
          rows={3}
          disabled={env.extraCwds}
          value={draft.extraCwdsText}
          onChange={(e) => set({ extraCwdsText: e.target.value })}
        />
      </Field>

      <div className="setup-field">
        <div className="setup-label">{t('set.voices')}</div>
        {draft.voices.length === 0 && <p className="setup-muted">{t('set.voices.empty')}</p>}
        {draft.voices.map((v: VoiceRow, i: number) => (
          <div className="setup-row" key={v.id}>
            <span className="cr-mono setup-voice-id">{v.id}</span>
            <span className="setup-voice-name">{v.name}</span>
            <button type="button" className="cc-btn" onClick={() => removeVoice(i)}>
              {t('set.voices.remove')}
            </button>
          </div>
        ))}
        <div className="setup-row">
          <input
            className="cc-input"
            type="text"
            aria-label={t('set.voices.id')}
            placeholder={t('set.voices.id')}
            value={voiceId}
            onChange={(e) => setVoiceId(e.target.value)}
          />
          <input
            className="cc-input"
            type="text"
            aria-label={t('set.voices.name')}
            placeholder={t('set.voices.name')}
            value={voiceName}
            onChange={(e) => setVoiceName(e.target.value)}
          />
          <button type="button" className="cc-btn" onClick={addVoice}>
            {t('set.voices.add')}
          </button>
        </div>
        {voiceErr && <p className="setup-error">{voiceErr}</p>}
      </div>

      <div className="setup-field">
        <div className="setup-label">
          {t('set.key')}: <span className={state.secrets.elevenlabs === 'set' ? 'st-ok' : 'st-warn'}>{keyLabel}</span>
        </div>
        <div className="setup-row">
          <input
            className="cc-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('set.key')}
            placeholder={t('set.key.placeholder')}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button type="button" className="cc-btn" disabled={keyBusy || keyInput.trim() === ''} onClick={() => void saveKey()}>
            {t('set.key.save')}
          </button>
          <button type="button" className="cc-btn" disabled={keyBusy || state.secrets.elevenlabs !== 'set'} onClick={() => void clearKey()}>
            {t('set.key.clear')}
          </button>
        </div>
        {keyMsg && <p className={keyMsg.ok ? 'setup-ok' : 'setup-error'}>{keyMsg.text}</p>}
      </div>

      <p className="setup-muted cr-mono setup-paths">{t('set.paths', { dataDir: state.dataDir, file: state.file })}</p>

      <div className="setup-savebar">
        <button type="button" className="cc-btn is-primary" disabled={saving} onClick={() => void save()}>
          {saving ? t('set.saving') : t('set.save')}
        </button>
        {msg && <span className={msg.ok ? 'setup-ok' : 'setup-error'}>{msg.text}</span>}
      </div>
    </div>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="setup-field">
      <div className="setup-label">{label}</div>
      {children}
      {note && <p className="setup-muted">{note}</p>}
    </div>
  );
}

// ---------- doctor tab ----------

function DoctorTab() {
  const t = useT();
  const [lang] = useLang();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let alive = true;
    void fetchDoctor().then((r) => {
      if (!alive) return;
      if (r.ok) setReport(r.value);
      else setErr(r.error);
      setBusy(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const recheck = async () => {
    setBusy(true);
    setErr(null);
    const r = await refreshDoctor();
    if (r.ok) setReport(r.value);
    else setErr(r.error);
    setBusy(false);
  };

  return (
    <div className="setup-doctor">
      <div className="setup-row">
        <span className="setup-summary">{report ? (report.ok ? t('doc.allOk') : t('doc.someFail')) : busy ? t('doc.checking') : ''}</span>
        <button type="button" className="cc-btn" disabled={busy} onClick={() => void recheck()}>
          {busy ? t('doc.checking') : t('doc.recheck')}
        </button>
      </div>
      {report && (
        <p className="setup-muted">
          {t('doc.checkedAt', { time: new Date(report.checkedAt).toLocaleTimeString(lang === 'th' ? 'th-TH' : 'en-GB') })}
        </p>
      )}
      {err && <p className="setup-error">{t('setup.loadError', { message: err })}</p>}
      <ul className="setup-checks">
        {(report?.checks ?? []).map((c) => {
          const titleKey = checkTitleKey(c.id);
          const hintKey = checkHintKey(c.id);
          return (
            <li key={c.id} className="setup-check-row">
              <span className={`setup-badge ${statusClass(c.status)}`}>{t(statusKey(c.status))}</span>
              <div className="setup-check-main">
                <div className="setup-check-title">{tx(titleKey, undefined, c.id)}</div>
                {hintKey && <div className="setup-muted">{tx(hintKey)}</div>}
                <div className="cr-mono setup-detail">{c.detail}</div>
                {c.fix && c.status !== 'ok' && <div className="setup-fix">{t('doc.fix', { fix: c.fix })}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
