// "งานที่บันทึกไว้": remembered sessions to reopen another day. Delete only removes a row from the list (files stay).
import { useEffect, useMemo, useRef, useState } from 'react';
import { EFFORT_LEVELS, MODEL_OPTIONS, type EffortLevel, type PermissionMode, DEFAULT_PERMISSION_MODE } from '../../../shared/protocol';
import { cwdTail, jobFlags } from '../control';
import { getLanguage, useT } from '../i18n';
import { serverText } from '../i18n/serverMsg';
import type { SavedSession } from '../protocolNext';
import {
  SAVED_PAGE,
  clockTime,
  countTab,
  filterSaved,
  groupByDay,
  limitGroups,
  resumeDefaults,
  rowActions,
  sourceWord,
  type SavedTab,
} from '../savedList';
import { PermissionModeField, type Command } from './Controls';
import { shortModel } from './graphLayout';
import './control.css';
import './saved.css';

export interface SavedWidgetProps {
  saved: SavedSession[];
  /** Session ids that have a node on the canvas. */
  onCanvas: ReadonlySet<string>;
  command: Command | undefined;
  offlineReason: string | null;
  /** Fly the canvas to this session's node. */
  onGoto: (sessionId: string) => void;
  /** A resumed job was started: show it once it appears. */
  onResumed: (sessionId: string) => void;
}

const CONFIRM_MS = 4000;
const TOAST_MS = 6000;

function ResumeForm({ s, busy, onSubmit, onCancel }: { s: SavedSession; busy: boolean; onSubmit: (model: string, effort: EffortLevel, mode: PermissionMode, confirmed: boolean) => void; onCancel: () => void }) {
  const t = useT();
  const d = resumeDefaults(s);
  const [model, setModel] = useState(d.model);
  const [effort, setEffort] = useState<EffortLevel>(d.effort);
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="sv-resume" role="group" aria-label={t('panels.savedWidget.resumeAria')}>
      <label className="sv-f">
        <span>{t('panels.savedWidget.model')}</span>
        <select className="cc-sel" value={model} onChange={(e) => setModel(e.target.value)}>
          {MODEL_OPTIONS.map((o) => (
            <option key={o.id} value={o.id} disabled={!!o.disabled} title={o.disabled}>
              {o.disabled ? `${o.label} (${o.disabled})` : o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="sv-f sv-f--s">
        <span>Effort</span>
        <select className="cc-sel" value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
          {EFFORT_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <div className="sv-f">
        <span>{t('panels.savedWidget.mode')}</span>
        <PermissionModeField
          value={mode}
          onCommit={(m, c) => {
            setMode(m);
            setConfirmed(c);
          }}
        />
      </div>
      <div className="cc-row sv-resume-btns">
        <button type="button" className="cc-btn is-primary" disabled={busy} onClick={() => onSubmit(model, effort, mode, confirmed)}>
          {busy ? t('panels.savedWidget.opening') : t('panels.savedWidget.openJob')}
        </button>
        <button type="button" className="cc-btn" disabled={busy} onClick={onCancel}>
          {t('panels.savedWidget.cancel')}
        </button>
      </div>
    </div>
  );
}

export function SavedWidget({ saved, onCanvas, command, offlineReason, onGoto, onResumed }: SavedWidgetProps) {
  const t = useT();
  const [tab, setTab] = useState<SavedTab>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(SAVED_PAGE);
  const [armed, setArmed] = useState<string | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = Date.now();

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  useEffect(() => {
    setLimit(SAVED_PAGE);
    setArmed(null);
    setResuming(null);
  }, [tab, query]);

  const say = (text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  const rows = useMemo(() => filterSaved(saved, tab, query), [saved, tab, query]);
  const groups = useMemo(() => limitGroups(groupByDay(rows, now), limit), [rows, limit, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = rows.length;
  const shown = groups.reduce((n, g) => n + g.items.length, 0);

  const call = async (id: string, fn: (c: Command) => ReturnType<Command>): Promise<boolean> => {
    if (!command) {
      say(offlineReason ?? t('panels.savedWidget.notStarted'));
      return false;
    }
    setBusy(id);
    const r = await fn(command);
    setBusy(null);
    if (!r.ok) say(serverText(r) || t('panels.savedWidget.failed'));
    return r.ok;
  };

  const onDelete = (id: string) => {
    if (armed !== id) {
      setArmed(id);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(null), CONFIRM_MS);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(null);
    void call(id, (c) => c({ type: 'saved_hide', sessionId: id }));
  };

  return (
    <div className="sv-root">
      <div className="cs-tabs" role="tablist" aria-label={t('panels.savedWidget.tabsAria')}>
        {(['all', 'trash'] as const).map((tabKey) => (
          <button key={tabKey} type="button" role="tab" aria-selected={tab === tabKey} className={`cs-tab${tab === tabKey ? ' is-on' : ''}`} onClick={() => setTab(tabKey)}>
            {tabKey === 'all' ? t('panels.savedWidget.all') : t('panels.savedWidget.trash')} <span className="sv-count">{countTab(saved, tabKey)}</span>
          </button>
        ))}
      </div>
      <div className="sv-search">
        <input className="cc-input" type="search" value={query} placeholder={t('panels.savedWidget.searchPlaceholder')} aria-label={t('panels.savedWidget.searchAria')} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="sv-list" role="tabpanel">
        {total === 0 && <div className="cc-muted sv-empty">{query ? t('panels.savedWidget.noMatch') : tab === 'trash' ? t('panels.savedWidget.trashEmpty') : t('panels.savedWidget.noSaved')}</div>}
        {groups.map((g) => (
          <section key={g.key} className="sv-day" aria-label={g.label}>
            <h3 className="sv-dayhead">{g.label}</h3>
            <ul>
              {g.items.map((s) => {
                const a = rowActions(s, tab, (id) => onCanvas.has(id));
                const isBusy = busy === s.sessionId;
                const model = shortModel(s.model);
                return (
                  <li key={s.sessionId} className={`sv-row${s.live ? ' is-live' : ''}`}>
                    <div className="sv-main">
                      <div className="sv-title" title={s.title}>
                        {s.live && <span className="sv-live" role="img" aria-label={t('panels.savedWidget.openNow')} title={t('panels.savedWidget.openNow')} />}
                        <span className="sv-name">{s.title || t('panels.savedWidget.untitled')}</span>
                      </div>
                      <div className="sv-meta">
                        <span className="sv-cwd" title={s.cwd}>
                          {cwdTail(s.cwd)}
                        </span>
                        {model && <span>{model}</span>}
                        <span className={`sv-src is-${s.source}`}>{sourceWord(s.source)}</span>
                        <span className="sv-time" title={new Date(s.lastActivity).toLocaleString(getLanguage() === 'th' ? 'th-TH' : 'en-US')}>
                          {clockTime(s.lastActivity)}
                        </span>
                      </div>
                    </div>
                    <div className="sv-acts">
                      <button
                        type="button"
                        className="cc-btn sv-btn"
                        disabled={!!a.primaryDisabled || isBusy}
                        title={a.primaryDisabled ?? undefined}
                        onClick={() => {
                          if (a.primary === 'goto') onGoto(s.sessionId);
                          else if (a.primary === 'restore') void call(s.sessionId, (c) => c({ type: 'saved_unhide', sessionId: s.sessionId }));
                          else setResuming((cur) => (cur === s.sessionId ? null : s.sessionId));
                        }}
                      >
                        {a.primaryLabel}
                      </button>
                      {a.canDelete && (
                        <button
                          type="button"
                          className={`cc-btn sv-btn${armed === s.sessionId ? ' is-danger' : ''}`}
                          disabled={isBusy}
                          aria-label={armed === s.sessionId ? t('panels.savedWidget.confirmDeleteAria', { title: s.title }) : t('panels.savedWidget.deleteAria', { title: s.title })}
                          title={t('panels.savedWidget.removeTitle')}
                          onClick={() => onDelete(s.sessionId)}
                        >
                          {armed === s.sessionId ? t('panels.savedWidget.confirmQ') : t('panels.savedWidget.delete')}
                        </button>
                      )}
                    </div>
                    {resuming === s.sessionId && (
                      <ResumeForm
                        s={s}
                        busy={isBusy}
                        onCancel={() => setResuming(null)}
                        onSubmit={async (model, effort, mode, confirmed) => {
                          const flags = jobFlags(mode, confirmed, false);
                          const r = await (async () => {
                            if (!command) {
                              say(offlineReason ?? t('panels.savedWidget.notStarted'));
                              return null;
                            }
                            setBusy(s.sessionId);
                            const res = await command({ type: 'saved_resume', sessionId: s.sessionId, model, effort, permissionMode: flags.permissionMode, ...(flags.confirm ? { confirm: true } : {}) });
                            setBusy(null);
                            return res;
                          })();
                          if (!r) return;
                          if (r.ok) {
                            setResuming(null);
                            onResumed(r.sessionId ?? s.sessionId);
                          } else say(serverText(r) || t('panels.savedWidget.failed'));
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {shown < total && (
          <button type="button" className="cc-btn sv-more" onClick={() => setLimit((n) => n + SAVED_PAGE)}>
            {t('panels.savedWidget.showMore', { shown, total })}
          </button>
        )}
      </div>
      {toast && (
        <div className="sv-toast" role="alert">
          {toast}
        </div>
      )}
      <div className="sv-foot cc-muted">{t('panels.savedWidget.deleteNote')}</div>
    </div>
  );
}
