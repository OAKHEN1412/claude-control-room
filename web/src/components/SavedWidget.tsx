// "งานที่บันทึกไว้": remembered sessions to reopen another day. Delete only removes a row from the list (files stay).
import { useEffect, useMemo, useRef, useState } from 'react';
import { EFFORT_LEVELS, MODEL_OPTIONS, type EffortLevel, type PermissionMode, DEFAULT_PERMISSION_MODE } from '../../../shared/protocol';
import { cwdTail, jobFlags } from '../control';
import type { SavedSession } from '../protocolNext';
import {
  DELETE_NOTE,
  SAVED_PAGE,
  SOURCE_WORD,
  clockTime,
  countTab,
  filterSaved,
  groupByDay,
  limitGroups,
  resumeDefaults,
  rowActions,
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
  const d = resumeDefaults(s);
  const [model, setModel] = useState(d.model);
  const [effort, setEffort] = useState<EffortLevel>(d.effort);
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="sv-resume" role="group" aria-label="เปิดงานต่อ">
      <label className="sv-f">
        <span>โมเดล</span>
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
        <span>โหมด</span>
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
          {busy ? 'กำลังเปิด…' : 'เปิดงาน'}
        </button>
        <button type="button" className="cc-btn" disabled={busy} onClick={onCancel}>
          ยกเลิก
        </button>
      </div>
    </div>
  );
}

export function SavedWidget({ saved, onCanvas, command, offlineReason, onGoto, onResumed }: SavedWidgetProps) {
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
      say(offlineReason ?? 'ยังสั่งงานไม่ได้');
      return false;
    }
    setBusy(id);
    const r = await fn(command);
    setBusy(null);
    if (!r.ok) say(r.error ?? 'ทำไม่สำเร็จ ลองอีกครั้ง');
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
      <div className="cs-tabs" role="tablist" aria-label="หมวดงานที่บันทึกไว้">
        {(['all', 'trash'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`cs-tab${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)}>
            {t === 'all' ? 'ทั้งหมด' : 'ถังขยะ'} <span className="sv-count">{countTab(saved, t)}</span>
          </button>
        ))}
      </div>
      <div className="sv-search">
        <input className="cc-input" type="search" value={query} placeholder="ค้นหาชื่องาน โฟลเดอร์ โมเดล" aria-label="ค้นหางานที่บันทึกไว้" onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="sv-list" role="tabpanel">
        {total === 0 && <div className="cc-muted sv-empty">{query ? 'ไม่พบงานที่ตรงกับคำค้น' : tab === 'trash' ? 'ถังขยะว่างอยู่' : 'ยังไม่มีงานที่บันทึกไว้'}</div>}
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
                        {s.live && <span className="sv-live" role="img" aria-label="กำลังเปิดอยู่" title="กำลังเปิดอยู่" />}
                        <span className="sv-name">{s.title || '(ไม่มีชื่อ)'}</span>
                      </div>
                      <div className="sv-meta">
                        <span className="sv-cwd" title={s.cwd}>
                          {cwdTail(s.cwd)}
                        </span>
                        {model && <span>{model}</span>}
                        <span className={`sv-src is-${s.source}`}>{SOURCE_WORD[s.source]}</span>
                        <span className="sv-time" title={new Date(s.lastActivity).toLocaleString('th-TH')}>
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
                          aria-label={armed === s.sessionId ? `กดอีกครั้งเพื่อยืนยันลบ ${s.title}` : `ลบ ${s.title}`}
                          title="เอาออกจากรายการ ไฟล์ยังอยู่"
                          onClick={() => onDelete(s.sessionId)}
                        >
                          {armed === s.sessionId ? 'ยืนยัน?' : 'ลบ'}
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
                              say(offlineReason ?? 'ยังสั่งงานไม่ได้');
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
                          } else say(r.error ?? 'ทำไม่สำเร็จ ลองอีกครั้ง');
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
            แสดงเพิ่ม ({shown}/{total})
          </button>
        )}
      </div>
      {toast && (
        <div className="sv-toast" role="alert">
          {toast}
        </div>
      )}
      <div className="sv-foot cc-muted">{DELETE_NOTE}</div>
    </div>
  );
}
