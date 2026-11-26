// Per-job account chip (3B): shows the profile a job runs as and opens a dropdown to switch it.
// Logic lives in accountJobLogic.ts; this file only renders and calls setAccount on confirm.
import { useEffect, useRef, useState } from 'react';
import type { RunnerState } from '../../../shared/protocol';
import { useT } from '../i18n';
import { badgeOf, errText, needsUnlock, visibleProfiles } from '../accountsView';
import { useAccounts } from '../accountsContext';
import { AccountAvatar } from './AccountAvatar';
import { chipModel, confirmText, isLockedFailure, profileName, currentAccountId } from '../accountJobLogic';
import './accountJob.css';

/** Small padlock icon for a locked profile. The label is the accessible name (e.g. the translated "ล็อก"). */
export function LockGlyph({ label, size = 12 }: { label: string; size?: number }) {
  return (
    <svg
      role="img"
      aria-label={label}
      className="acct-lock"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export interface AccountChipProps {
  sessionId: string;
  runner?: RunnerState;
  /** Read-only: show the pill only, no dropdown (used on job cards). */
  readOnly?: boolean;
}

/** Confirm panel shared by the chip and the limit card. Calls setAccount only after the click on the confirm button. */
export function SwitchConfirm({
  sessionId,
  targetId,
  targetName,
  busy,
  onDone,
  onCancel,
}: {
  sessionId: string;
  targetId: string;
  targetName: string;
  busy: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const acct = useAccounts();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setWorking(true);
    setError(null);
    const r = await acct.setAccount(sessionId, targetId);
    setWorking(false);
    if (r.ok) {
      onDone();
    } else if (isLockedFailure(r)) {
      // The server refuses a locked profile: ask for its password instead of showing an error.
      acct.openUnlockDialog(targetId);
    } else {
      setError(errText(r.error ?? 'SERVER_ERROR'));
    }
  };

  return (
    <div className="acct-job-confirm" role="group" aria-label={t('acct.job.confirmAria')}>
      <p className="acct-job-confirm-text">{confirmText(targetName, busy)}</p>
      {error && (
        <p className="acct-job-err" role="alert">
          {error}
        </p>
      )}
      <div className="acct-job-actions">
        <button type="button" className="acct-job-btn is-primary" disabled={working} onClick={confirm}>
          {working ? t('acct.job.switching') : t('acct.job.confirm')}
        </button>
        <button type="button" className="acct-job-btn" disabled={working} onClick={onCancel}>
          {t('acct.job.cancel')}
        </button>
      </div>
    </div>
  );
}

export function AccountChip({ sessionId, runner, readOnly }: AccountChipProps) {
  const t = useT();
  const accounts = useAccounts();
  const model = chipModel(runner, accounts);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Outside click and Esc close the dropdown (and drop any open confirm panel).
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setPicked(null);
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!model.visible || !runner) return null;

  const busy = runner.busy || runner.queued > 0;
  const label = model.pendingName ? t('acct.job.pending', { name: model.pendingName }) : model.name;
  const avatar = (
    <AccountAvatar
      account={{ color: model.avatar.color, letter: model.avatar.letter, name: model.name, builtin: model.avatar.builtin, main: model.avatar.main }}
      size={18}
    />
  );

  if (readOnly) {
    return (
      <span className="acct-job-chip is-readonly" title={model.name}>
        {avatar}
        <span className="acct-job-name">{model.waitingLabel ?? label}</span>
        {model.locked && <LockGlyph label={t('acct.job.locked')} />}
      </span>
    );
  }

  // Waiting job: it resumes by itself once its profile is unlocked; the button opens the unlock dialog.
  if (model.waitingFor) {
    return (
      <span className="acct-job-chip is-readonly" title={model.waitingLabel ?? model.name}>
        {avatar}
        <span className="acct-job-name">{model.waitingLabel}</span>
        <LockGlyph label={t('acct.job.locked')} />
        <button
          type="button"
          className="acct-job-btn is-primary"
          onClick={() => accounts.openUnlockDialog(model.waitingFor ?? model.id)}
        >
          {t('acct.job.unlock')}
        </button>
      </span>
    );
  }

  const currentId = currentAccountId(runner, accounts.defaultAccountId);
  const rows = visibleProfiles(accounts.accounts, accounts.defaultAccountId);
  const pickedRow = picked ? rows.find((a) => a.id === picked) : undefined;
  const now = Date.now();

  return (
    <span className="acct-job-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`acct-job-chip${model.enabled ? '' : ' is-disabled'}`}
        disabled={!model.enabled}
        title={model.enabled ? model.name : t('acct.job.notAlive')}
        aria-label={t('acct.job.chipAria')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setPicked(null);
          setOpen((o) => !o);
        }}
      >
        {avatar}
        <span className="acct-job-name">{label}</span>
        {model.locked && <LockGlyph label={t('acct.job.locked')} />}
      </button>
      {open && (
        <div className="acct-job-menu" role="listbox" aria-label={t('acct.job.menuAria')}>
          {pickedRow ? (
            <SwitchConfirm
              sessionId={sessionId}
              targetId={pickedRow.id}
              targetName={profileName(pickedRow)}
              busy={busy}
              onDone={() => {
                setOpen(false);
                setPicked(null);
              }}
              onCancel={() => setPicked(null)}
            />
          ) : (
            rows.map((a) => {
              const isCurrent = a.id === currentId;
              const badge = badgeOf(a, now, accounts.usage);
              return (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  aria-label={isCurrent ? `${profileName(a)} · ${t('acct.job.current')}` : profileName(a)}
                  className={`acct-job-row${isCurrent ? ' is-current' : ''}`}
                  onClick={() => {
                    if (isCurrent) {
                      setOpen(false);
                      return;
                    }
                    if (needsUnlock(a)) {
                      // Locked: unlock first; the confirm panel opens only after the unlock succeeds.
                      setOpen(false);
                      setPicked(null);
                      accounts.openUnlockDialog(a.id, () => {
                        setOpen(true);
                        setPicked(a.id);
                      });
                      return;
                    }
                    setPicked(a.id);
                  }}
                >
                  <AccountAvatar account={a} size={22} />
                  <span className="acct-job-name">{profileName(a)}</span>
                  {needsUnlock(a) && <LockGlyph label={t('acct.job.locked')} />}
                  {badge.kind === 'limit' && <span className="acct-job-badge is-limit">{t('acct.limit')}</span>}
                  {badge.kind === 'week' && <span className="acct-job-badge">{t('acct.week', { pct: badge.pct })}</span>}
                  {isCurrent && <span className="acct-job-tick" aria-hidden="true">✓</span>}
                </button>
              );
            })
          )}
        </div>
      )}
    </span>
  );
}
