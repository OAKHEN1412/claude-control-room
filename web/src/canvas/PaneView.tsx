// The inside of a work pane: terminal log filling the pane, send box at the bottom, and a slim icon rail on the
// right whose icons open small flyouts with the session picker, model/effort/mode/RC and quick chips.
// Shared by the pane node on the canvas and the slide-out drawer.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { RunnerState, SessionInfo } from '../../../shared/protocol';
import { useAgentTimeline } from '../agentTimeline';
import { Compose, ModelEffort, PendingList, QuickPanel, useCommand, useJobButtons, type Command } from '../components/Controls';
import { StatusChip, cwdTail } from '../components/SessionPane';
import { shortModel } from '../components/graphLayout';
import { useT } from '../i18n';
import { TerminalLog } from '../components/TerminalLog';
import { BoltIcon, ExpandIcon, LinkIcon, PowerIcon, SlidersIcon, StopIcon, TakeoverIcon, TerminalIcon } from './icons';
import type { PaneSource } from './paneStore';

export const SHOW_EVENTS = 40;
const STICK_PX = 24;

type Panel = 'session' | 'model' | 'quick';

export interface PaneViewProps {
  source: PaneSource | null;
  session: SessionInfo | null;
  sessions: SessionInfo[];
  runner?: RunnerState;
  command?: Command;
  /** On screen and not compact: render the log and poll the subagent timeline. */
  active: boolean;
  /** Changes when something outside asks for the session picker (the pane's input port). */
  openSessionToken?: number;
  onConnect: (sessionId: string) => void;
  onDisconnect: () => void;
  onClearAgent: () => void;
  onFullScreen: (sessionId: string) => void;
}

function RailButton({ label, pressed, disabled, danger, onClick, children }: { label: string; pressed?: boolean; disabled?: boolean; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`cv-rail-btn${danger ? ' is-danger' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** "ส่งคำตอบต่อไปที่…": keyboard route to a relay link (the same thing as dragging a wire between two session nodes). */
function LinkTo({ from, sessions, command }: { from: string; sessions: SessionInfo[]; command: Command }) {
  const t = useT();
  const others = sessions.filter((s) => s.sessionId !== from);
  const [to, setTo] = useState('');
  const [done, setDone] = useState(false);
  const { run, error, working } = useCommand(command);
  const label = (s: SessionInfo) => `${s.title && s.title !== '(ไม่มีชื่อ)' ? s.title : s.name} — ${cwdTail(s.cwd)}`;
  return (
    <div className="cv-linkto" role="group" aria-label={t('canvas.paneView.linkToAria')}>
      <div className="cv-fly-title">{t('canvas.paneView.linkToTitle')}</div>
      <select
        aria-label={t('canvas.paneView.pickTarget')}
        className="cp-select"
        value={to}
        disabled={others.length === 0}
        onChange={(e) => {
          setTo(e.target.value);
          setDone(false);
        }}
      >
        <option value="">{others.length === 0 ? t('canvas.paneView.noOther') : t('canvas.paneView.pickTarget')}</option>
        {others.map((s) => (
          <option key={s.sessionId} value={s.sessionId}>
            {label(s)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="cc-btn"
        disabled={!to || working}
        onClick={async () => {
          const r = await run({ type: 'link_create', from, to });
          setDone(r.ok);
        }}
      >
        {working ? t('canvas.paneView.linking') : t('canvas.paneView.link')}
      </button>
      {done && !error && <div className="cc-ok" role="status">{t('canvas.paneView.linked')}</div>}
      {error && (
        <div className="cn-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function JobRail({ session, runner, command }: { session: SessionInfo; runner: RunnerState | undefined; command: Command }) {
  const t = useT();
  const j = useJobButtons({ session, runner, command });
  return (
    <>
      <RailButton label={j.terminal.title} disabled={j.terminal.disabled} onClick={j.terminal.onClick}>
        <TerminalIcon />
      </RailButton>
      {j.takeover.visible && (
        <RailButton label={j.takeover.title} danger={j.takeover.armed} disabled={j.takeover.disabled} onClick={j.takeover.onClick}>
          <TakeoverIcon />
        </RailButton>
      )}
      {j.takeover.armed && <span className="cv-rail-confirm" role="status">{t('canvas.paneView.confirm')}</span>}
      <RailButton label={j.stop.title} disabled={j.stop.disabled} onClick={j.stop.onClick}>
        <StopIcon />
      </RailButton>
      <RailButton label={j.close.armed ? t('canvas.paneView.closeConfirm') : (j.close.title ?? t('canvas.paneView.closeJob'))} danger={j.close.armed} disabled={j.close.disabled} onClick={j.close.onClick}>
        <PowerIcon />
      </RailButton>
      {j.close.armed && <span className="cv-rail-confirm" role="status">{t('canvas.paneView.confirm')}</span>}
      {j.error && (
        <span className="cv-rail-err" role="alert" title={j.error}>
          !
        </span>
      )}
    </>
  );
}

export function PaneView({ source, session, sessions, runner, command, active, openSessionToken, onConnect, onDisconnect, onClearAgent, onFullScreen }: PaneViewProps) {
  const t = useT();
  const [panel, setPanel] = useState<Panel | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const sid = session?.sessionId ?? null;
  const agentId = session && source?.agentId ? source.agentId : null;
  const agent = session && agentId ? (session.subagents.find((a) => a.id === agentId) ?? null) : null;
  const agentMode = agent !== null;
  const remoteSession = session?.machineId !== undefined; // the subagent timeline API reads this PC's transcripts only
  const tl = useAgentTimeline(sid, agentMode && !remoteSession ? agentId : null, active && agentMode && !remoteSession, agent?.finished ?? false, agent?.finished ? agent.lastActivity : null);

  const events = agentMode ? (tl.data?.timeline ?? []) : session ? session.timeline.slice(-SHOW_EVENTS) : [];
  const lastTs = events.length > 0 ? events[events.length - 1].ts : 0;
  const thought = agentMode ? (agent?.thought ?? '') : (session?.thought ?? '');

  useEffect(() => {
    if (openSessionToken) setPanel('session');
  }, [openSessionToken]);

  // A different block starts pinned to the bottom.
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
  }, [sid, agentId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [sid, agentId, events.length, lastTs, thought, active]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = near;
    setAtBottom(near);
  };

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p));
  const onFlyKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setPanel(null);
    }
  };

  const parentName = session ? (session.title && session.title !== '(ไม่มีชื่อ)' ? session.title : session.name) : '';

  return (
    <div className="cv-pv">
      <div className="cp-pane cv-pv-main" data-drop-host="1">
        {session && agentMode && agent && (
          <div className="cv-agenthead">
            <span className="cv-agenthead-text" title={agent.description}>
              subagent · {agent.description} · {shortModel(agent.model) ?? t('canvas.paneView.unknownModel')}
            </span>
            <button type="button" className="cv-link" onClick={onClearAgent} title={t('canvas.paneView.backTo', { name: parentName })}>
              ← {parentName}
            </button>
          </div>
        )}
        {!active ? (
          <div className="cp-scroll is-term cv-pane-log" />
        ) : session ? (
          <div
            className="cp-scroll is-term cv-pane-log"
            ref={scrollRef}
            onScroll={onScroll}
            tabIndex={0}
            role="region"
            aria-label={t('canvas.paneView.historyAria', { name: session.name })}
          >
            {agentMode && remoteSession ? (
              <div className="cv-agentnote">
                <div>{agent?.thought || t('canvas.paneView.noSubagentData')}</div>
                <div className="cc-muted">{t('canvas.paneView.localOnly')}</div>
              </div>
            ) : agentMode && tl.failed && events.length === 0 ? (
              <div className="cv-agentnote">
                <div>{agent?.thought || t('canvas.paneView.noSubagentData')}</div>
                <div className="cc-muted">{t('canvas.paneView.logUnavailable')}</div>
              </div>
            ) : (
              <TerminalLog events={events} thought={thought} emptyText={agentMode && tl.loading ? t('canvas.paneView.loadingLog') : undefined} />
            )}
          </div>
        ) : (
          <div className="cp-scroll is-term cv-pane-log cv-unconnected">
            <div className="cv-unconnected-title">{t('canvas.paneView.unconnected')}</div>
            <div className="cv-unconnected-hint">{t('canvas.paneView.dragHint')}</div>
          </div>
        )}
        {active && session && !atBottom && (
          <button type="button" className="cv-latest" onClick={toBottom} data-nodrag="1">
            {t('canvas.paneView.latest')}
          </button>
        )}
        {active && session && command && <PendingList session={session} runner={runner} command={command} />}
        {active && session && command && <Compose session={session} runner={runner} command={command} compact />}
      </div>

      <nav className="cv-rail" aria-label={t('canvas.paneView.railAria')}>
        <RailButton label={t('canvas.paneView.pickJob')} pressed={panel === 'session'} onClick={() => toggle('session')}>
          <LinkIcon />
        </RailButton>
        <RailButton label={t('canvas.paneView.modelTitle')} pressed={panel === 'model'} disabled={!session || !command} onClick={() => toggle('model')}>
          <SlidersIcon />
        </RailButton>
        <RailButton label={t('canvas.paneView.quickTitle')} pressed={panel === 'quick'} disabled={!session || !command} onClick={() => toggle('quick')}>
          <BoltIcon />
        </RailButton>
        <RailButton label={t('canvas.paneView.fullscreen')} disabled={!session} onClick={() => sid && onFullScreen(sid)}>
          <ExpandIcon />
        </RailButton>
        <span className="cv-rail-sep" aria-hidden="true" />
        {session && command && <JobRail session={session} runner={runner} command={command} />}
      </nav>

      {panel && (
        <div className="cv-fly" role="dialog" aria-label={t('canvas.paneView.settingsAria')} onKeyDown={onFlyKey}>
          {panel === 'session' && (
            <>
              <div className="cv-fly-title">{t('canvas.paneView.linkTitle')}</div>
              <select
                aria-label={t('canvas.paneView.pickSession')}
                className="cp-select"
                value={sid ?? ''}
                onChange={(e) => {
                  if (e.target.value) onConnect(e.target.value);
                }}
              >
                {!session && (
                  <option value="" disabled>
                    {t('canvas.paneView.pickSession')}
                  </option>
                )}
                {sessions.map((s) => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {`${s.title && s.title !== '(ไม่มีชื่อ)' ? s.title : s.name} · ${s.name} — ${cwdTail(s.cwd)}`}
                  </option>
                ))}
              </select>
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
                </>
              )}
              {source && (
                <button type="button" className="cc-btn" onClick={onDisconnect}>
                  {t('canvas.paneView.disconnect')}
                </button>
              )}
              <div className="cc-muted">{t('canvas.paneView.orDrag')}</div>
              {session && command && <LinkTo key={session.sessionId} from={session.sessionId} sessions={sessions} command={command} />}
            </>
          )}
          {panel === 'model' && session && command && (
            <>
              <div className="cv-fly-title">{t('canvas.paneView.modelAndMode')}</div>
              <ModelEffort session={session} runner={runner} command={command} />
            </>
          )}
          {panel === 'quick' && session && command && (
            <>
              <div className="cv-fly-title">{t('canvas.paneView.quickKeys')}</div>
              <QuickPanel session={session} runner={runner} command={command} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
