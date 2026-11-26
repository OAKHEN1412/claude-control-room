// The "บัญชี" row of the v2 model/mode popover: a select of usable profiles. Choosing another one goes through
// the same confirm panel as the account chip; a locked profile opens the unlock dialog first.
import { useState } from 'react';
import type { RunnerState } from '../../../shared/protocol';
import { SwitchConfirm } from '../components/AccountChip';
import { useAccounts } from '../accountsContext';
import { nameOfId } from '../accountJobLogic';
import { popoverRow } from '../canvasAccount';
import { useT } from '../i18n';

export function AccountRow({ sessionId, runner }: { sessionId: string; runner: RunnerState | undefined }) {
  const t = useT();
  const acct = useAccounts();
  const row = popoverRow(runner, acct);
  const [picked, setPicked] = useState<string | null>(null);
  if (!row.visible) return null;

  const busy = !!runner && (runner.busy || runner.queued > 0);
  const onChange = (id: string) => {
    if (id === row.value) {
      setPicked(null);
      return;
    }
    const opt = row.options.find((o) => o.id === id);
    if (opt?.locked) {
      // Locked: unlock first; the confirm panel opens only after the unlock succeeds.
      acct.openUnlockDialog(id, () => setPicked(id));
      return;
    }
    setPicked(id);
  };

  return (
    <div className="cv-acctrow" role="group" aria-label={t('acct.job.rowAria')}>
      <label className="cv-acctrow-label" htmlFor={`cv-acct-${sessionId}`}>
        {t('acct.job.row')}
      </label>
      <select
        id={`cv-acct-${sessionId}`}
        className="cp-select"
        value={row.value}
        disabled={row.disabled}
        title={row.reasonKey ? t(row.reasonKey) : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {row.options.map((o) => (
          <option key={o.id} value={o.id}>
            {`${o.label}${o.id === row.value ? ' ✓' : ''}${o.locked ? ` · ${t('acct.job.locked')}` : ''}`}
          </option>
        ))}
      </select>
      {picked && picked !== row.value && (
        <SwitchConfirm
          sessionId={sessionId}
          targetId={picked}
          targetName={nameOfId(acct.accounts, picked)}
          busy={busy}
          onDone={() => setPicked(null)}
          onCancel={() => setPicked(null)}
        />
      )}
    </div>
  );
}
