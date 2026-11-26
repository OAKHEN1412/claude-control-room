import { Fragment, useEffect, useState, type KeyboardEvent } from 'react';
import type { AccountInfo, MainAccountInfo } from '../../../shared/accounts';
import { useT, type TKey } from '../i18n';
import { useAccounts } from '../accountsContext';
import { getMainAccount, mainLogout } from '../accountsClient';
import { displayName, errText, weekAndFiveHour } from '../accountsView';
import { MainLoginPanel } from './MainLoginPanel';
import { AccountAvatar } from './AccountAvatar';
import {
  ARM_IDLE,
  MAIN_ARM_MS,
  armPress,
  mainErrorKey,
  mainExpiryView,
  relTimeText,
  type ArmState,
} from '../accountsPageLogic';

export interface MainAccountRowProps {
  account: AccountInfo; // the builtin terminal profile
  now: number;
  lang: 'th' | 'en';
  isDefault: boolean;
  onMakeDefault(): void;
  /** Shows or clears the page-level error line. */
  onError(msg: string | null): void;
}

/**
 * The builtin "main account" row on /accounts: full email, plan, org, login expiry and state, plus the
 * two-click "change main account" (arm, then logout and the inline login panel).
 */
export function MainAccountRow(props: MainAccountRowProps) {
  const t = useT();
  const ctx = useAccounts();
  const { account, now, lang } = props;

  // The server caches status for 60 s; one forced read when the page opens refreshes it.
  const [fresh, setFresh] = useState<MainAccountInfo | null>(null);
  const [arm, setArm] = useState<ArmState>(ARM_IDLE);
  const [busy, setBusy] = useState(false);
  const [swapping, setSwapping] = useState(false);

  const refresh = async () => {
    const r = await getMainAccount(true);
    if (!r.ok) return;
    const { ok: _ok, ...info } = r;
    setFresh(info);
  };

  useEffect(() => {
    void refresh();
    // Once per mount: the page opens with one fresh read of the main account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The armed first click reverts on its own after MAIN_ARM_MS.
  useEffect(() => {
    if (!arm.armed) return;
    const since = arm.since;
    const h = setTimeout(() => setArm((s) => (s.armed && s.since === since ? ARM_IDLE : s)), MAIN_ARM_MS);
    return () => clearTimeout(h);
  }, [arm]);

  const info: MainAccountInfo | null = fresh ?? account.main ?? null;
  const loggedIn = info?.loggedIn === true;
  const expiry = mainExpiryView(info?.expiresAt ?? null, now);
  // Claude Code renews this login itself: neutral text unless it is nearly over (warn) or past (expired).
  const expiryText =
    !loggedIn || expiry.kind === 'none'
      ? '—'
      : expiry.kind === 'auto'
        ? t('acct.main.expiry.auto', { date: expiry.date ?? '' })
        : expiry.kind === 'warn'
          ? t('acct.expiry.warn', { days: expiry.days ?? 0 })
          : t('acct.expiry.expired');
  const expiryCls = expiry.kind === 'warn' ? 'ap-exp-warn' : expiry.kind === 'expired' ? 'ap-exp-expired' : 'ap-exp-none';
  const name = displayName(account, (k) => t(k as TKey));

  const doSwap = async () => {
    setBusy(true);
    props.onError(null);
    const r = await mainLogout();
    setBusy(false);
    if (!r.ok) {
      const key = mainErrorKey(r.error);
      props.onError(key ? t(key as TKey) : errText(r.error));
      return;
    }
    if (r.main) setFresh(r.main);
    setSwapping(true);
  };

  const onArmClick = () => {
    const { state, action } = armPress(arm, Date.now());
    setArm(state);
    if (action === 'confirm') void doSwap();
  };

  const onLoginSuccess = () => {
    setSwapping(false);
    void refresh();
  };

  const onEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setArm(ARM_IDLE);
  };

  return (
    <Fragment>
      <tr className="ap-trow ap-main-row">
        <td className="ap-cell ap-cell-name" data-label={t('acct.mng.colName')}>
          <div className="ap-name-line">
            <AccountAvatar
              account={{ color: account.color, letter: account.letter, name, builtin: account.builtin, main: info ?? undefined }}
              size={36}
            />
            <div className="ap-name-main">
              <span className="ap-name ap-name-static">{name}</span>
              <div className="ap-tags">
                <span className="ap-tag">{t('acct.mng.builtinTag')}</span>
              </div>
            </div>
          </div>
        </td>
        <td className="ap-cell" data-label={t('acct.mng.colNote')}>
          <span className="ap-muted">{t('acct.terminal.note')}</span>
        </td>
        <td className="ap-cell" data-label={t('acct.mng.colToken')}>
          <div className="ap-main-meta">
            <span className="ap-muted">{t('acct.mng.main.email')}</span>
            {/* Own row: the full address is shown here only; other lists mask it. */}
            <code className="ap-email">{info?.email ?? '—'}</code>
          </div>
          <div className="ap-main-meta">
            <span className="ap-muted">{t('acct.mng.main.plan')}:</span> <span>{info?.plan ?? '—'}</span>
          </div>
          {info?.orgName && (
            <div className="ap-main-meta">
              <span className="ap-muted">{t('acct.mng.main.org')}:</span> <span>{info.orgName}</span>
            </div>
          )}
        </td>
        <td className="ap-cell" data-label={t('acct.mng.colExpiry')}>
          <span className={`ap-exp ${expiryCls}`}>{info === null ? '—' : expiryText}</span>
          {loggedIn && info?.expiresAt && expiry.kind !== 'auto' ? <div className="ap-muted">{t('acct.mng.main.loginExpiry')}</div> : null}
        </td>
        <td className="ap-cell" data-label={t('acct.mng.colCheck')}>
          {info === null ? (
            <div className="ap-check ap-check-never">
              <span aria-hidden="true">–</span> {t('acct.mng.main.checking')}
            </div>
          ) : (
            <div className={`ap-check ${loggedIn ? 'ap-check-ok' : 'ap-check-fail'}`}>
              <span aria-hidden="true">{loggedIn ? '✓' : '✕'}</span>{' '}
              {loggedIn ? t('acct.mng.main.loggedIn') : t('acct.mng.main.loggedOut')}
            </div>
          )}
          {info && <div className="ap-muted">{t('acct.mng.checkedAgo', { ago: relTimeText(info.checkedAt, now, lang) })}</div>}
        </td>
        <td className="ap-cell" data-label={t('acct.mng.colUsage')}>
          {/* The main account has no usage of its own: its bars are the global snapshot the header rings show. */}
          {(() => {
            const u = weekAndFiveHour(account, ctx.usage);
            const bar = (label: string, pct: number | null) => (
              <div className="ap-bar-row">
                <span className="ap-bar-label">{label}</span>
                <span className="ap-bar" aria-hidden="true">
                  <span className="ap-bar-fill" style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
                </span>
                <span className="ap-bar-val">{pct === null ? '—' : `${pct}%`}</span>
              </div>
            );
            return (
              <>
                {bar(t('acct.mng.usage5h'), u.five)}
                {bar(t('acct.mng.usageWeek'), u.seven)}
              </>
            );
          })()}
        </td>
        <td className="ap-cell" data-label={t('acct.mng.colDefault')}>
          <label className="ap-radio">
            <input type="radio" name="acct-default" value={account.id} checked={props.isDefault} onChange={props.onMakeDefault} />
            <span>{t('acct.mng.default')}</span>
          </label>
        </td>
        <td className="ap-cell ap-actions" data-label={t('acct.mng.colActions')}>
          <button
            type="button"
            className={arm.armed ? 'cc-btn ap-danger-armed' : 'cc-btn'}
            aria-pressed={arm.armed}
            disabled={busy || swapping || !ctx.ptyAvailable}
            title={ctx.ptyAvailable ? undefined : t('acct.err.PTY_UNAVAILABLE')}
            onClick={onArmClick}
            onKeyDown={onEscape}
          >
            {arm.armed ? t('acct.mng.main.changeConfirm') : t('acct.mng.main.change')}
          </button>
        </td>
      </tr>
      {arm.armed && (
        <tr className="ap-trow ap-revoke-row">
          <td colSpan={8}>
            <p className="ap-revoke" role="alert" onKeyDown={onEscape}>
              {t('acct.mng.main.warn')}
            </p>
          </td>
        </tr>
      )}
      {swapping && (
        <tr className="ap-trow ap-revoke-row">
          <td colSpan={8}>
            <section className="ap-main-login" aria-label={t('acct.mng.main.loginTitle')}>
              <h3 className="ap-form-title">{t('acct.mng.main.loginTitle')}</h3>
              <MainLoginPanel mainLogin={ctx.mainLogin} ptyAvailable={ctx.ptyAvailable} onSuccess={onLoginSuccess} />
            </section>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
