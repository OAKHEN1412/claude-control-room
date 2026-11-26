import { useState } from 'react';
import type { RunnerState, SessionInfo } from '../../../shared/protocol';
import { type UsageSnapshot, levelOf } from '../../../shared/usage';
import { type RingView, awaitingProfileUsage, contextRing, effectiveUsage, liveSessionIds, pickContext, profileLabel, quotaRing, withProfile } from '../usageView';
import { useAccounts } from '../accountsContext';
import { useT } from '../i18n';
import './usage.css';

export interface UsageRingsProps {
  usage: UsageSnapshot;
  sessions: SessionInfo[];
  runners: Record<string, RunnerState>;
  selectedSessionId: string | null;
  now: number;
}

const R = 11;
const C = 2 * Math.PI * R;

function Ring({ view, open, onOpen, children }: { view: RingView; open: boolean; onOpen: (o: boolean) => void; children?: React.ReactNode }) {
  const t = useT();
  const frac = view.pct === null ? 0 : Math.max(0, Math.min(1, view.pct / 100));
  const summary = `${view.title}: ${view.pct === null ? t('shell.usage.noData') : `${Math.round(view.pct)}%`}`;
  return (
    <div
      className={`cr-ring is-${view.level}${view.dim ? ' is-dim' : ''}${open ? ' is-open' : ''}`}
      data-ring={view.key}
      onMouseEnter={() => onOpen(true)}
      onMouseLeave={() => onOpen(false)}
    >
      <button
        type="button"
        className="cr-ring-btn"
        aria-label={summary}
        aria-expanded={open}
        onFocus={() => onOpen(true)}
        onBlur={() => onOpen(false)}
        onClick={() => onOpen(!open)}
      >
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
          <circle className="cr-ring-track" cx="14" cy="14" r={R} />
          <circle className="cr-ring-arc" cx="14" cy="14" r={R} strokeDasharray={`${C * frac} ${C}`} transform="rotate(-90 14 14)" />
          <text className="cr-ring-num" x="14" y="14" textAnchor="middle" dominantBaseline="central">
            {view.text}
          </text>
        </svg>
        <span className="cr-ring-label">{view.label}</span>
      </button>
      <div className="cr-ring-pop" role="tooltip">
        <b>{view.title}</b>
        {view.lines.map((l, i) => (
          <div key={i} className={i === 0 ? 'cr-ring-big' : 'cr-ring-line'}>
            {l}
          </div>
        ))}
        {children}
      </div>
    </div>
  );
}

export function UsageRings({ usage: globalUsage, sessions, runners, selectedSessionId, now }: UsageRingsProps) {
  const t = useT();
  const { accounts, defaultAccountId } = useAccounts();
  const [open, setOpen] = useState<string | null>(null);
  // The quota rings follow the header profile; the context ring keeps the global session data.
  const usage = effectiveUsage(globalUsage, defaultAccountId, accounts);
  const fetching = awaitingProfileUsage(defaultAccountId, accounts);
  const label = profileLabel(defaultAccountId, accounts);
  const nameOf = (id: string) => {
    const s = sessions.find((x) => x.sessionId === id);
    return s ? s.title || s.name || id.slice(0, 8) : id.slice(0, 8);
  };
  const live = liveSessionIds(sessions, runners);
  const { session, rows } = pickContext(globalUsage, selectedSessionId, live);
  const followed = session !== null && session.sessionId === selectedSessionId;
  const five = withProfile(quotaRing('five', usage.fiveHour, now), label, fetching);
  const week = withProfile(quotaRing('week', usage.sevenDay, now), label, fetching);
  const ctx = contextRing(session, followed, now, nameOf);
  const bind = (k: string) => (o: boolean) => setOpen((cur) => (o ? k : cur === k ? null : cur));
  return (
    <div className="cr-usage" role="group" aria-label={t('shell.usage.group')}>
      <Ring view={five} open={open === 'five'} onOpen={bind('five')} />
      <Ring view={week} open={open === 'week'} onOpen={bind('week')} />
      <Ring view={ctx} open={open === 'ctx'} onOpen={bind('ctx')}>
        {rows.length > 0 && (
          <ul className="cr-ring-list">
            {rows.map((r) => (
              <li key={r.sessionId} className={r.sessionId === session?.sessionId ? 'is-current' : ''}>
                <span className="cr-ring-name">{nameOf(r.sessionId)}</span>
                <span className={`cr-ring-pct is-${levelOf(r.ctxPct ?? 0)}`}>
                  {Math.round(r.ctxPct ?? 0)}%{r.estimated ? '~' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Ring>
    </div>
  );
}
