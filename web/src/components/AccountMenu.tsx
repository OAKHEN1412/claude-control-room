// Header account pill (avatar + name + caret) and its Google-style popover, plus the toast shown after a switch.
// The default profile is the "current" one; picking another row makes it the default for NEW jobs only.
import { useEffect, useRef, useState } from 'react';
import { useAccounts } from '../accountsContext';
import { setDefaultAccount } from '../accountsClient';
import { tx, useT } from '../i18n';
import { displayName, needsUnlock, profileById } from '../accountsView';
import {
  TOAST_HIDE_MS,
  barWidth,
  idleJobsToMove,
  isOutside,
  moveErrorText,
  pctText,
  popoverBadge,
  popoverModel,
  popoverSubline,
  summarizeMoves,
  type ToastState,
} from '../accountMenuLogic';
import type { AccountInfo } from '../../../shared/accounts';
import type { RunnerState } from '../../../shared/protocol';
import { AccountAvatar } from './AccountAvatar';
import { LockGlyph } from './AccountChip';
import './accountMenu.css';

export interface AccountMenuProps {
  runners: Record<string, RunnerState>;
  /** Test hook: render the popover already open (server-side render tests). */
  initialOpen?: boolean;
}

function Bar({ label, pct }: { label: string; pct: number | null }) {
  return (
    <div className="acct-bar-row">
      <span className="acct-bar-label">{label}</span>
      <span className="acct-bar-val cr-mono">{pctText(pct)}</span>
      <div className="acct-bar" aria-hidden="true">
        <span style={{ width: `${barWidth(pct)}%` }} />
      </div>
    </div>
  );
}

export function AccountMenu({ runners, initialOpen = false }: AccountMenuProps) {
  const t = useT();
  const ctx = useAccounts();
  const [open, setOpen] = useState(initialOpen);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const model = popoverModel(ctx.accounts, ctx.defaultAccountId, ctx.usage);
  const now = Date.now();
  const curAccount = profileById(ctx.accounts, model.current.id);
  // The built-in profile is always named by its translated label (the Terminal login has no own name).
  const curName = curAccount ? displayName(curAccount, tx) : model.current.name || t('acct.terminal.name');
  const subline = popoverSubline(curAccount);
  const curLocked = curAccount ? needsUnlock(curAccount) : false;

  const showToast = (s: ToastState) => {
    setToast(s);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setToast(null), TOAST_HIDE_MS);
  };

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  // Outside click and Esc close the popover; Esc returns focus to the pill.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (isOutside(rootRef.current, e.target)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        pillRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const switchTo = async (a: AccountInfo) => {
    setBusy(true);
    const r = await setDefaultAccount(a.id);
    setBusy(false);
    if (!r.ok) {
      showToast({ kind: 'error', text: moveErrorText(r.error) });
      return;
    }
    setOpen(false);
    showToast({ kind: 'switched', accountId: a.id, name: displayName(a, tx) });
  };

  // A locked profile is offered but never switched to directly: the unlock dialog runs first, then the switch.
  const pick = async (a: AccountInfo) => {
    if (needsUnlock(a)) {
      setOpen(false);
      ctx.openUnlockDialog(a.id, () => void switchTo(a));
      return;
    }
    await switchTo(a);
  };

  const moveIdle = async (accountId: string) => {
    const ids = idleJobsToMove(runners, accountId);
    if (ids.length === 0) {
      showToast({ kind: 'none' });
      return;
    }
    setBusy(true);
    const results: { ok: boolean; error?: string }[] = [];
    for (const sessionId of ids) results.push(await ctx.setAccount(sessionId, accountId));
    setBusy(false);
    const s = summarizeMoves(results);
    showToast({ kind: 'moved', n: s.moved, error: s.firstError === null ? null : moveErrorText(s.firstError) });
  };

  const toastText = (s: ToastState): string => {
    switch (s.kind) {
      case 'switched':
        return t('acct.pop.toast', { name: s.name });
      case 'moved':
        return s.error
          ? `${t('acct.pop.moved', { n: s.n })} · ${t('acct.pop.moveFailed', { error: s.error })}`
          : t('acct.pop.moved', { n: s.n });
      case 'none':
        return t('acct.pop.noneIdle');
      case 'error':
        return s.text;
    }
  };

  return (
    <div className="acct-menu" ref={rootRef}>
      <button
        ref={pillRef}
        type="button"
        className="acct-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'acct-pop' : undefined}
        aria-label={t('acct.pop.pill', { name: curName })}
        onClick={() => setOpen((o) => !o)}
      >
        <AccountAvatar account={{ ...model.current, name: curName }} size={22} />
        <span className="acct-pill-name">{curName}</span>
        <span className="acct-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div id="acct-pop" role="dialog" aria-label={t('acct.pop.menu')} className="acct-pop">
          <div className="acct-pop-head">
            <AccountAvatar account={{ ...model.current, name: curName }} size={56} />
            <div className="acct-pop-who">
              <div className="acct-hello">
                {t('acct.pop.hello', { name: curName })}
                {curLocked && <LockGlyph label={t('acct.pop.locked')} />}
              </div>
              {subline && <div className="acct-muted cr-mono">{subline}</div>}
              <div className="acct-muted">{t('acct.pop.current')}</div>
              {curLocked && curAccount && (
                <button
                  className="acct-unlock-link"
                  type="button"
                  onClick={() => ctx.openUnlockDialog(curAccount.id)}
                >
                  {t('acct.pop.unlockCurrent')}
                </button>
              )}
            </div>
          </div>

          <div className="acct-bars">
            <Bar label={t('acct.pop.five')} pct={model.five} />
            <Bar label={t('acct.pop.week')} pct={model.seven} />
          </div>

          <a className="acct-manage" href="/accounts">
            {t('acct.pop.manage')}
          </a>

          <div className="acct-section">{t('acct.pop.others')}</div>
          <ul className="acct-list">
            {model.others.map((a) => {
              const b = popoverBadge(a, now, ctx.usage);
              return (
                <li key={a.id}>
                  <button type="button" className="acct-row" disabled={busy} onClick={() => void pick(a)}>
                    <AccountAvatar account={a} size={28} />
                    <span className="acct-row-name">{displayName(a, tx)}</span>
                    {needsUnlock(a) && <LockGlyph label={t('acct.pop.locked')} />}
                    {b.kind === 'limit' && <span className="acct-badge is-limit">{t('acct.limit')}</span>}
                    {b.kind === 'week' && <span className="acct-badge cr-mono">{t('acct.week', { pct: b.pct })}</span>}
                  </button>
                </li>
              );
            })}
            <li>
              <button
                type="button"
                className="acct-row acct-add"
                onClick={() => {
                  setOpen(false);
                  ctx.openAddDialog();
                }}
              >
                {t('acct.pop.add')}
              </button>
            </li>
          </ul>

          <p className="acct-foot">{t('acct.pop.footer')}</p>
        </div>
      )}

      {toast && (
        <div className="acct-toast" role="status">
          <span className="acct-toast-text">{toastText(toast)}</span>
          {toast.kind === 'switched' && (
            <button type="button" className="acct-toast-btn" disabled={busy} onClick={() => void moveIdle(toast.accountId)}>
              {t('acct.pop.moveIdle')}
            </button>
          )}
          <button type="button" className="acct-toast-btn" onClick={() => setToast(null)}>
            {t('acct.pop.dismiss')}
          </button>
        </div>
      )}
    </div>
  );
}
