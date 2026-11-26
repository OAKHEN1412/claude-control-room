// Usage-limit card (3C) inside a local job pane. Lists other profiles to continue with.
// Nothing here switches by itself: every switch starts from a click and goes through the confirm panel.
import { useState } from 'react';
import type { RunnerState } from '../../../shared/protocol';
import { useT } from '../i18n';
import { useAccounts } from '../accountsContext';
import { AccountAvatar } from './AccountAvatar';
import { LockGlyph, SwitchConfirm } from './AccountChip';
import { canSwitch, currentAccountId, limitRows } from '../accountJobLogic';
import { needsUnlock } from '../accountsView';
import './accountJob.css';

export interface LimitSwitchCardProps {
  sessionId: string;
  runner?: RunnerState;
  /** Limit label shown in red, e.g. "ติดลิมิต · resets 1:30pm (Asia/Bangkok)". */
  label: string;
}

export function LimitSwitchCard({ sessionId, runner, label }: LimitSwitchCardProps) {
  const t = useT();
  const accounts = useAccounts();
  const [picked, setPicked] = useState<string | null>(null);

  const now = Date.now();
  const currentId = currentAccountId(runner, accounts.defaultAccountId);
  const rows = limitRows(accounts.accounts, currentId, now, accounts.usage);
  const can = canSwitch(runner);
  const busy = !!runner && (runner.busy || runner.queued > 0);
  const pickedRow = picked ? rows.find((r) => r.account.id === picked) : undefined;

  return (
    <section className="acct-limit" aria-label={t('acct.job.limitHeading')}>
      <div className="acct-limit-label">{label}</div>
      <div className="acct-limit-heading">{t('acct.job.limitHeading')}</div>
      {pickedRow ? (
        <SwitchConfirm
          sessionId={sessionId}
          targetId={pickedRow.account.id}
          targetName={pickedRow.name}
          busy={busy}
          onDone={() => setPicked(null)}
          onCancel={() => setPicked(null)}
        />
      ) : rows.length === 0 ? (
        <p className="acct-job-hint">
          {t('acct.job.limitHint')} <a href="/accounts">{t('acct.job.limitManage')}</a>
        </p>
      ) : (
        <ul className="acct-limit-list">
          {rows.map((r) => {
            const disabled = r.limited || !can;
            return (
              <li key={r.account.id}>
                <button
                  type="button"
                  className="acct-limit-row"
                  disabled={disabled}
                  title={!can ? t('acct.job.notAlive') : undefined}
                  onClick={() => {
                    // Locked: unlock first; the confirm panel opens only after the unlock succeeds.
                    if (needsUnlock(r.account)) accounts.openUnlockDialog(r.account.id, () => setPicked(r.account.id));
                    else setPicked(r.account.id);
                  }}
                >
                  <AccountAvatar account={r.account} size={22} />
                  <span className="acct-job-name">{r.name}</span>
                  {needsUnlock(r.account) && <LockGlyph label={t('acct.job.locked')} />}
                  {r.limited && <span className="acct-job-badge is-limit">{t('acct.limit')}</span>}
                  {r.badge.kind === 'week' && <span className="acct-job-badge">{t('acct.week', { pct: r.badge.pct })}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!pickedRow && <p className="acct-limit-note">{t('acct.job.limitNote')}</p>}
    </section>
  );
}
