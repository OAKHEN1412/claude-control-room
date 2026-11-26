import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ACCOUNT_COLORS, type AccountInfo, type ConnectEvent } from '../../../shared/accounts';
import { useServer } from '../useServer';
import { tx, useLang, useT } from '../i18n';
import { checkAccount, deleteAccount, patchAccount, setDefaultAccount, type ProfilePatch } from '../accountsClient';
import { errText } from '../accountsView';
import {
  DELETE_ARM_MS,
  DELETE_IDLE,
  buildRows,
  checkName,
  checkNote,
  deleteReducer,
  relTimeText,
  type DeleteState,
  type ManageRow,
} from '../accountsPageLogic';
import { useAccounts } from '../accountsContext';
import { AccountsHost } from './AccountsHost';
import { AccountAvatar } from './AccountAvatar';
import { MainAccountRow } from './MainAccountRow';
import { PasswordSection, LockBadge } from './PasswordSection';
import { AppLockSection } from './AppLockSection';
import './control.css';

/**
 * Profile manage page (/accounts). One useServer() connection for the page; AccountsHost supplies the account
 * context and the add/unlock dialogs. AccountsScreen is the props-only body.
 */
export function AccountsPage() {
  const server = useServer();
  return (
    <AccountsHost server={server}>
      <AccountsScreen
        accounts={server.accounts}
        defaultAccountId={server.defaultAccountId}
        ptyAvailable={server.ptyAvailable}
        connect={server.connect}
      />
    </AccountsHost>
  );
}

export interface AccountsScreenProps {
  accounts: AccountInfo[];
  defaultAccountId: string;
  ptyAvailable: boolean;
  connect: ConnectEvent | null;
}

interface EditState {
  id: string;
  field: 'name' | 'note';
  draft: string;
  err: string | null;
}

function UsageBar({ label, pct, bar }: { label: string; pct: number | null; bar: number }) {
  return (
    <div className="ap-bar-row">
      <span className="ap-bar-label">{label}</span>
      <span className="ap-bar" aria-hidden="true">
        <span className="ap-bar-fill" style={{ width: `${bar}%` }} />
      </span>
      <span className="ap-bar-val">{pct === null ? '—' : `${pct}%`}</span>
    </div>
  );
}

export function AccountsScreen({ accounts, defaultAccountId }: AccountsScreenProps) {
  const t = useT();
  const [uiLang, setUiLang] = useLang();
  const lang: 'th' | 'en' = uiLang === 'th' ? 'th' : 'en';
  const [now, setNow] = useState(() => Date.now());
  const ctx = useAccounts();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [del, setDel] = useState<DeleteState>(DELETE_IDLE);

  // Keeps "checked 5 min ago" and the expiry days fresh between server pushes.
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(h);
  }, []);

  // A first delete click reverts on its own after DELETE_ARM_MS.
  useEffect(() => {
    if (del.phase !== 'armed') return;
    const since = del.since;
    const h = setTimeout(
      () => setDel((d) => (d.phase === 'armed' && d.since === since ? DELETE_IDLE : d)),
      DELETE_ARM_MS,
    );
    return () => clearTimeout(h);
  }, [del]);

  const [pwFor, setPwFor] = useState<string | null>(null);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a] as const)), [accounts]);
  const rows = useMemo(() => buildRows(accounts, defaultAccountId, now, ctx.usage), [accounts, defaultAccountId, now, ctx.usage]);
  const armedId = del.phase === 'armed' ? del.id : null;
  const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-US');

  const save = async (row: ManageRow, field: 'name' | 'note', raw: string) => {
    const v = field === 'name' ? checkName(raw) : checkNote(raw);
    if (!v.ok) {
      setEditing((e) => (e && e.id === row.id ? { ...e, err: errText(v.error) } : e));
      return;
    }
    const patch: ProfilePatch = field === 'name' ? { name: v.value } : { note: v.value };
    const r = await patchAccount(row.id, patch);
    if (!r.ok) {
      setEditing((e) => (e && e.id === row.id ? { ...e, err: errText(r.error) } : e));
      return;
    }
    setEditing((e) => (e && e.id === row.id && e.field === field ? null : e));
  };

  const makeDefault = async (id: string) => {
    setError(null);
    const r = await setDefaultAccount(id);
    if (!r.ok) setError(errText(r.error));
  };

  const runCheck = async (id: string) => {
    setError(null);
    setChecking(id);
    const r = await checkAccount(id);
    setChecking(null);
    if (!r.ok) setError(errText(r.error));
  };

  const toggleHidden = async (row: ManageRow) => {
    setError(null);
    const r = await patchAccount(row.id, { hidden: !row.hidden });
    if (!r.ok) setError(errText(r.error));
  };

  const pickColor = async (row: ManageRow, color: string) => {
    setColorFor(null);
    if (color === row.color) return;
    setError(null);
    const r = await patchAccount(row.id, { color });
    if (!r.ok) setError(errText(r.error));
  };

  const onDeletePress = (row: ManageRow) => {
    const r = deleteReducer(del, { type: 'press', id: row.id, now: Date.now() });
    setDel(r.state);
    if (r.action !== 'confirm') return;
    setError(null);
    void deleteAccount(row.id).then((res) => {
      setDel((d) => deleteReducer(d, { type: 'reset' }).state);
      if (!res.ok) setError(`${t('acct.mng.deleteFailed')}: ${errText(res.error)}`);
    });
  };

  const cancelDelete = () => setDel((d) => deleteReducer(d, { type: 'cancel' }).state);

  const onEditKey = (e: KeyboardEvent<HTMLInputElement>, row: ManageRow, field: 'name' | 'note', draft: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save(row, field, draft);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(null);
    }
  };

  const renderName = (row: ManageRow): ReactNode => {
    const ed = editing && editing.id === row.id && editing.field === 'name' ? editing : null;
    return (
      <div className="ap-name-line">
        <AccountAvatar account={{ color: row.color, letter: row.letter, name: row.name, builtin: row.builtin, main: row.main }} size={36} />
        <div className="ap-name-main">
          {ed ? (
            <div className="ap-edit">
              <input
                className="cc-input ap-input"
                aria-label={t('acct.mng.renameLabel')}
                maxLength={40}
                value={ed.draft}
                autoFocus
                onChange={(e) => setEditing({ ...ed, draft: e.target.value, err: null })}
                onKeyDown={(e) => onEditKey(e, row, 'name', ed.draft)}
              />
              <span className="ap-hint">{t('acct.mng.renameHint')}</span>
              {ed.err && <span className="ap-err-inline">{ed.err}</span>}
            </div>
          ) : (
            <button
              type="button"
              className="ap-name"
              title={t('acct.mng.rename')}
              onClick={() => setEditing({ id: row.id, field: 'name', draft: row.name, err: null })}
            >
              {row.name}
            </button>
          )}
          <div className="ap-tags">
            <button
              type="button"
              className="ap-swatch"
              style={{ background: row.color }}
              aria-label={t('acct.mng.color')}
              aria-haspopup="menu"
              aria-expanded={colorFor === row.id}
              onClick={() => setColorFor(colorFor === row.id ? null : row.id)}
            />
            {row.builtin && <span className="ap-tag">{t('acct.mng.builtinTag')}</span>}
            {row.hidden && <span className="ap-tag">{t('acct.mng.hiddenTag')}</span>}
          </div>
          {colorFor === row.id && (
            <div
              className="ap-colors"
              role="menu"
              aria-label={t('acct.mng.colorMenu')}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setColorFor(null);
              }}
            >
              {ACCOUNT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c === row.color}
                  aria-label={c}
                  className="ap-swatch-opt"
                  style={{ background: c }}
                  onClick={() => void pickColor(row, c)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderNote = (row: ManageRow): ReactNode => {
    const ed = editing && editing.id === row.id && editing.field === 'note' ? editing : null;
    if (ed) {
      return (
        <div className="ap-edit">
          <input
            className="cc-input ap-input"
            aria-label={t('acct.mng.noteLabel')}
            maxLength={80}
            value={ed.draft}
            autoFocus
            onChange={(e) => setEditing({ ...ed, draft: e.target.value, err: null })}
            onKeyDown={(e) => onEditKey(e, row, 'note', ed.draft)}
          />
          <span className="ap-hint">{t('acct.mng.renameHint')}</span>
          {ed.err && <span className="ap-err-inline">{ed.err}</span>}
        </div>
      );
    }
    return (
      <button
        type="button"
        className="ap-note-btn"
        title={t('acct.mng.editNote')}
        onClick={() => setEditing({ id: row.id, field: 'note', draft: row.note, err: null })}
      >
        {row.note || t('acct.mng.noNote')}
      </button>
    );
  };

  const renderRow = (row: ManageRow): ReactNode => {
    const acct = byId.get(row.id);
    if (row.builtin && acct) {
      return (
        <MainAccountRow
          key={row.id}
          account={acct}
          now={now}
          lang={lang}
          isDefault={row.isDefault}
          onMakeDefault={() => void makeDefault(row.id)}
          onError={setError}
        />
      );
    }
    const locked = acct?.locked === true;
    const armed = armedId === row.id;
    const deleting = del.phase === 'deleted' && del.id === row.id;
    const checkLabel =
      row.check === 'ok' ? t('acct.check.ok') : row.check === 'fail' ? t('acct.check.fail') : t('acct.check.never');
    const checkIcon = row.check === 'ok' ? '✓' : row.check === 'fail' ? '✕' : '–';
    return (
      <Fragment key={row.id}>
        <tr className={`ap-trow${row.hidden ? ' ap-hidden' : ''}${row.needsConnect ? ' ap-unset-row' : ''}`}>
          <td className="ap-cell ap-cell-name" data-label={t('acct.mng.colName')}>
            {renderName(row)}
          </td>
          <td className="ap-cell" data-label={t('acct.mng.colNote')}>
            {renderNote(row)}
          </td>
          <td className="ap-cell" data-label={t('acct.mng.colToken')}>
            {row.needsConnect ? (
              <div className="ap-unset">
                <span className="ap-unset-label">{t('acct.mng.notConnected')}</span>
                <button type="button" className="cc-btn ap-btn-sm" onClick={() => ctx.openAddDialog(row.id)}>
                  {t('acct.mng.connect')}
                </button>
              </div>
            ) : (
              <code className="ap-fp">{row.fingerprint}</code>
            )}
            <div className="ap-muted">{t('acct.mng.created', { date: fmtDate(row.createdAt) })}</div>
          </td>
          <td className="ap-cell" data-label={t('acct.mng.colExpiry')}>
            <span className={`ap-exp ${row.expiryClass}`}>{row.expiryKey ? tx(row.expiryKey, row.expiryVars) : '—'}</span>
          </td>
          <td className="ap-cell" data-label={t('acct.mng.colCheck')}>
            <div className={`ap-check ap-check-${row.check}`}>
              <span aria-hidden="true">{checkIcon}</span> {checkLabel}
            </div>
            {row.checkAt !== null && (
              <div className="ap-muted">{t('acct.mng.checkedAgo', { ago: relTimeText(row.checkAt, now, lang) })}</div>
            )}
            {locked ? (
              <LockBadge locked hasPassword t={t} />
            ) : (
              <button
                type="button"
                className="cc-btn ap-btn-sm"
                disabled={!row.tokenSet || checking !== null}
                onClick={() => void runCheck(row.id)}
              >
                {checking === row.id ? t('acct.mng.checking') : t('acct.mng.check')}
              </button>
            )}
          </td>
          <td className="ap-cell" data-label={t('acct.mng.colUsage')}>
            {locked ? (
              <LockBadge locked hasPassword t={t} />
            ) : (
              <>
                <UsageBar label={t('acct.mng.usage5h')} pct={row.fivePct} bar={row.fiveBar} />
                <UsageBar label={t('acct.mng.usageWeek')} pct={row.weekPct} bar={row.weekBar} />
              </>
            )}
          </td>
          <td className="ap-cell" data-label={t('acct.mng.colDefault')}>
            <label className="ap-radio">
              <input
                type="radio"
                name="acct-default"
                value={row.id}
                checked={row.isDefault}
                onChange={() => void makeDefault(row.id)}
              />
              <span>{t('acct.mng.default')}</span>
            </label>
          </td>
          <td className="ap-cell ap-actions" data-label={t('acct.mng.colActions')}>
            <div className="ap-actions-stack">
            {!row.builtin && row.tokenSet && (
              <button type="button" className="cc-btn" onClick={() => ctx.openAddDialog(row.id)}>
                {t('acct.mng.reconnect')}
              </button>
            )}
            {!row.builtin && (
              <button
                type="button"
                className="cc-btn"
                aria-expanded={pwFor === row.id}
                onClick={() => setPwFor(pwFor === row.id ? null : row.id)}
              >
                {t('acct.mng.pw.toggle')}
              </button>
            )}
            <button type="button" className="cc-btn" onClick={() => void toggleHidden(row)}>
              {row.hidden ? t('acct.mng.show') : t('acct.mng.hide')}
            </button>
            {!row.builtin &&
              (armed ? (
                <button
                  type="button"
                  className="cc-btn ap-danger-armed"
                  onClick={() => onDeletePress(row)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') cancelDelete();
                  }}
                  onBlur={cancelDelete}
                  autoFocus
                >
                  {t('acct.mng.deleteConfirm')}
                </button>
              ) : (
                <button
                  type="button"
                  className="cc-btn ap-danger"
                  disabled={deleting}
                  onClick={() => onDeletePress(row)}
                >
                  {t('acct.mng.delete')}
                </button>
              ))}
            </div>
          </td>
        </tr>
        {armed && (
          <tr className="ap-trow ap-revoke-row">
            <td colSpan={8}>
              <p className="ap-revoke" role="status">
                {t('acct.mng.revoke')}
              </p>
            </td>
          </tr>
        )}
        {pwFor === row.id && acct && (
          <tr className="ap-trow ap-pw-row">
            <td colSpan={8}>
              <PasswordSection account={acct} />
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="ap-page">
      <header className="ap-head">
        <a className="cc-btn ap-back" href="/">
          {t('acct.mng.back')}
        </a>
        <h1>{t('acct.mng.title')}</h1>
        <button type="button" className="cc-btn ap-add" onClick={() => ctx.openAddDialog()}>
          {t('acct.mng.add')}
        </button>
        <button
          type="button"
          className="cc-btn cr-lang"
          title={t('lang.toggle')}
          aria-label={t('lang.toggle')}
          onClick={() => setUiLang(uiLang === 'th' ? 'en' : 'th')}
        >
          {uiLang === 'th' ? t('lang.en') : t('lang.th')}
        </button>
      </header>

      <main className="ap-main">
        {error && (
          <p className="ap-error" role="alert">
            {error}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="ap-note">{t('acct.mng.empty')}</p>
        ) : (
          <div className="ap-table-wrap">
            <table className="ap-table">
              <colgroup>
                <col className="ap-col-name" />
                <col className="ap-col-note" />
                <col className="ap-col-token" />
                <col className="ap-col-expiry" />
                <col className="ap-col-check" />
                <col className="ap-col-usage" />
                <col className="ap-col-default" />
                <col className="ap-col-actions" />
              </colgroup>
              <thead>
                <tr className="ap-trow">
                  <th scope="col">{t('acct.mng.colName')}</th>
                  <th scope="col">{t('acct.mng.colNote')}</th>
                  <th scope="col">{t('acct.mng.colToken')}</th>
                  <th scope="col">{t('acct.mng.colExpiry')}</th>
                  <th scope="col">{t('acct.mng.colCheck')}</th>
                  <th scope="col">{t('acct.mng.colUsage')}</th>
                  <th scope="col">{t('acct.mng.colDefault')}</th>
                  <th scope="col">{t('acct.mng.colActions')}</th>
                </tr>
              </thead>
              <tbody>{rows.map(renderRow)}</tbody>
            </table>
          </div>
        )}
        <AppLockSection />
      </main>
    </div>
  );
}
