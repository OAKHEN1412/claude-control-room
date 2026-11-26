import { useEffect, useRef, type CSSProperties } from 'react';
import type { AgentInfo, RunnerState, SessionInfo } from '../../../shared/protocol';
import { Compose, ModelEffort, PendingList, type Command } from './Controls';
import { STATUS_VAR, STATUS_WORD, badgeText } from './graphLayout';
import { TerminalLog } from './TerminalLog';
import { AccountChip } from './AccountChip';
import { LimitSwitchCard } from './LimitSwitchCard';
import { isLocalJob } from '../accountJobLogic';
import { limitOf, limitText } from '../limit';
import { useT } from '../i18n';
import './pane.css';

export interface SessionPaneProps {
  session: SessionInfo | null;
  sessions: SessionInfo[]; // for the session picker
  onPick: (sessionId: string) => void;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  runner?: RunnerState; // set when this session is controlled from the web
  command?: Command; // missing = read-only (stage 1 behaviour)
  onFullScreen?: () => void;
}

const SHOW_EVENTS = 30;
const STICK_PX = 24;

/** Last two path segments, e.g. "...\production-tracker". */
export function cwdTail(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return cwd;
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : parts.join('\\');
}

export function StatusChip({ status }: { status: AgentInfo['status'] }) {
  useT(); // STATUS_WORD is read at render: subscribe so a language switch re-renders the chip
  const color = STATUS_VAR[status];
  const style: CSSProperties = { color, borderColor: color };
  return (
    <span className="cp-chip" style={style}>
      <span aria-hidden="true" className="cp-dot" style={{ background: color }} />
      {STATUS_WORD[status]}
    </span>
  );
}

function AgentCard({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
  const t = useT();
  return (
    <section className="cp-agent" aria-label={t('panels.sessionPane.agentAria')}>
      <div className="cp-agent-head">
        <span className="cp-agent-meta">{t('panels.sessionPane.agentMeta', { badge: badgeText(agent.model, agent.effort) })}</span>
        <button type="button" className="cp-btn" onClick={onClose}>
          {t('panels.sessionPane.close')}
        </button>
      </div>
      <div className="cp-agent-title">{agent.description}</div>
      <div className="cp-agent-status">
        <StatusChip status={agent.status} />
        <span className="cp-muted">{agent.finished ? t('panels.sessionPane.finished') : t('panels.sessionPane.stillWorking')}</span>
      </div>
      <div className="cp-agent-thought">{agent.thought}</div>
    </section>
  );
}

export function SessionPane({
  session,
  sessions,
  onPick,
  selectedAgentId,
  onSelectAgent,
  runner,
  command,
  onFullScreen,
}: SessionPaneProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const sid = session?.sessionId ?? null;
  const events = session ? session.timeline.slice(-SHOW_EVENTS) : [];
  const lastTs = events.length > 0 ? events[events.length - 1].ts : 0;

  // A new session starts pinned to the bottom.
  useEffect(() => {
    stick.current = true;
  }, [sid]);

  // Auto-scroll to the newest event unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [sid, events.length, lastTs, session?.thought]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  // Account chip and limit card only for jobs this web controls (no remote machine).
  const localJob = isLocalJob(session, runner);
  const limit = limitOf(session, runner);
  const limitLabel = limit ? limitText(session, runner) : null;

  const agent =
    session && selectedAgentId
      ? (session.subagents.find((a) => a.id === selectedAgentId) ?? null)
      : null;

  return (
    <div className="cp-pane" data-drop-host="1">
      <div className="cp-head">
        <div className="cp-top">
          <select
            aria-label={t('panels.sessionPane.pick')}
            className="cp-select"
            value={sid ?? ''}
            onChange={(e) => {
              if (e.target.value) onPick(e.target.value);
            }}
          >
            {!session && (
              <option value="" disabled>
                {t('panels.sessionPane.pick')}
              </option>
            )}
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {`${s.title && s.title !== '(ไม่มีชื่อ)' ? s.title : s.name} · ${s.name} — ${cwdTail(s.cwd)}`}
              </option>
            ))}
          </select>
        </div>

        {session && (
          <>
            <div className="cp-path" title={session.cwd}>
              {session.cwd}
            </div>
            <div className="cp-meta">
              <StatusChip status={session.status} />
              <span className="cp-title" title={session.title}>
                {session.title}
              </span>
            </div>
            {localJob && <AccountChip sessionId={session.sessionId} runner={runner} />}
            {localJob && limit && limitLabel && <LimitSwitchCard sessionId={session.sessionId} runner={runner} label={limitLabel} />}
          </>
        )}
        {session && command && <ModelEffort session={session} runner={runner} command={command} />}
        {session && onFullScreen && (
          <button type="button" className="cp-btn" onClick={onFullScreen}>
            {t('panels.sessionPane.fullChat')}
          </button>
        )}
      </div>

      {session ? (
        <div
          className="cp-scroll is-term"
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          role="region"
          aria-label={t('panels.sessionPane.historyAria', { name: session.name })}
        >
          {agent && <AgentCard agent={agent} onClose={() => onSelectAgent(null)} />}

          <TerminalLog events={events} thought={session.thought} accountLog={runner?.accountLog} />
        </div>
      ) : (
        <div className="cp-scroll cp-empty-wrap">
          <div className="cp-empty">{t('panels.sessionPane.pick')}</div>
        </div>
      )}
      {session && command && <PendingList session={session} runner={runner} command={command} />}
      {session && command && <Compose session={session} runner={runner} command={command} />}
    </div>
  );
}
