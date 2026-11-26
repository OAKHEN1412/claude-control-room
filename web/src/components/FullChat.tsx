import { useEffect, useRef } from 'react';
import type { RunnerState, SessionInfo } from '../../../shared/protocol';
import { Compose, ModelEffort, PendingList, type Command } from './Controls';
import { STATUS_VAR, STATUS_WORD } from './graphLayout';
import { TerminalLog } from './TerminalLog';
import { useT } from '../i18n';
import './control.css';

export interface FullChatProps {
  session: SessionInfo;
  runner: RunnerState | undefined;
  command: Command;
  onClose: () => void;
}

/** Full-screen chat for one session: same controls as the pane, bigger. */
export function FullChat({ session, runner, command, onClose }: FullChatProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const last = session.timeline.length > 0 ? session.timeline[session.timeline.length - 1].ts : 0;
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.sessionId, session.timeline.length, last, session.thought]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section className="cf-overlay" data-drop-host="1" role="dialog" aria-modal="true" aria-label={t('shell.fullChat.aria')}>
      <div className="cf-head">
        <button type="button" className="cc-btn" onClick={onClose}>
          {t('shell.fullChat.back')}
        </button>
        <div className="cf-title">
          <h2>{session.title || session.name}</h2>
          <div className="cf-path">
            {session.cwd} · <span style={{ color: STATUS_VAR[session.status], fontWeight: 600 }}>{STATUS_WORD[session.status]}</span>
          </div>
        </div>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <ModelEffort session={session} runner={runner} command={command} large />
        </div>
      </div>
      <div className="cf-body is-term" ref={ref}>
        <div className="cf-col">
          <TerminalLog events={session.timeline} thought={session.thought} accountLog={runner?.accountLog} />
        </div>
      </div>
      <div className="cf-pend">
        <div>
          <PendingList session={session} runner={runner} command={command} />
        </div>
      </div>
      <div className="cf-foot">
        <div>
          <Compose session={session} runner={runner} command={command} large />
        </div>
      </div>
    </section>
  );
}
