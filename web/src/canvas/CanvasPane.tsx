// A work pane as a node on the canvas: title bar (drag handle, session, status, close), the pane view,
// an input port on the left edge and a resize handle in the corner. World coordinates, so it scales with the canvas.
import { limitText } from '../limit';
import { memo, type KeyboardEvent } from 'react';
import { useState } from 'react';
import type { RunnerState, SessionInfo } from '../../../shared/protocol';
import type { Command } from '../components/Controls';
import { STATUS_VAR } from '../components/graphLayout';
import { useT } from '../i18n';
import { CloseIcon } from './icons';
import { PaneView } from './PaneView';
import { statusWord } from './canvasLayout';
import { lastLine, type PaneNode } from './paneStore';
import { AccountChip } from '../components/AccountChip';
import { isLocalJob } from '../accountJobLogic';

export interface CanvasPaneProps {
  pane: PaneNode;
  session: SessionInfo | null;
  sessions: SessionInfo[];
  runner?: RunnerState;
  command?: Command;
  /** Zoomed far out: draw only the title and the last line. */
  compact: boolean;
  /** On screen (with a margin); off-screen panes skip their log. */
  visible: boolean;
  /** A wire being dragged is over this pane. */
  hot: boolean;
  focused: boolean;
  onClose: (id: string) => void;
  onConnect: (id: string, sessionId: string) => void;
  onDisconnect: (id: string) => void;
  onClearAgent: (id: string) => void;
  onFullScreen: (sessionId: string) => void;
  onNudge: (id: string, dx: number, dy: number, resize: boolean) => void;
}

const STEP = 24;
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export const CanvasPane = memo(function CanvasPane(p: CanvasPaneProps) {
  const t = useT();
  const { pane, session } = p;
  const [token, setToken] = useState(0);
  const agent = session && pane.source?.agentId ? session.subagents.find((a) => a.id === pane.source!.agentId) : undefined;
  const status = agent ? agent.status : session?.status;
  const color = status ? STATUS_VAR[status] : 'var(--idle)';
  const name = session ? (session.title && session.title !== '(ไม่มีชื่อ)' ? session.title : session.name) : t('canvas.pane.unconnected');
  const sub = agent ? `subagent · ${agent.description}` : session ? statusWord(session.status) : t('canvas.pane.dragHint');

  const limit = agent ? null : limitText(session, p.runner);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault();
    p.onNudge(pane.id, dir[0] * STEP, dir[1] * STEP, e.shiftKey);
  };

  return (
    <div
      className={`cv-pane${p.hot ? ' is-hot' : ''}${p.focused ? ' is-focused' : ''}${session ? '' : ' is-empty'}${limit ? ' is-limit' : ''}`}
      data-pane={pane.id}
      data-status={status ?? undefined}
      role="group"
      tabIndex={0}
      aria-label={t('canvas.pane.aria', { name })}
      style={{ left: pane.x, top: pane.y, width: pane.w, height: pane.h, zIndex: pane.z }}
      onKeyDown={onKeyDown}
    >
      <div className="cv-pane-title" data-panehandle="1" title={t('canvas.pane.dragTitle')}>
        <span className="cv-pane-dot" style={{ background: color }} aria-hidden="true" />
        <span className="cv-pane-name">{name}</span>
        <span className="cv-pane-sub">{limit ?? sub}</span>
        {session && !p.compact && isLocalJob(session, p.runner) && (
          <span className="cv-pane-acct" data-nodrag="1">
            <AccountChip sessionId={session.sessionId} runner={p.runner} />
          </span>
        )}
        <button type="button" className="cv-pane-x" data-nodrag="1" aria-label={t('canvas.pane.close')} title={t('canvas.pane.close')} onClick={() => p.onClose(pane.id)}>
          <CloseIcon />
        </button>
      </div>

      {p.compact ? (
        <div className="cv-pane-compact" data-panehandle="1">
          <div className="cv-pane-compact-name">{name}</div>
          <div className="cv-pane-compact-line">{limit ?? (session ? lastLine(session) || sub : t('canvas.pane.unconnected'))}</div>
        </div>
      ) : (
        <div className="cv-pane-body">
          <PaneView
            source={pane.source}
            session={session}
            sessions={p.sessions}
            runner={p.runner}
            command={p.command}
            active={p.visible}
            openSessionToken={token}
            onConnect={(sid) => p.onConnect(pane.id, sid)}
            onDisconnect={() => p.onDisconnect(pane.id)}
            onClearAgent={() => p.onClearAgent(pane.id)}
            onFullScreen={p.onFullScreen}
          />
        </div>
      )}

      <button
        type="button"
        className="cv-pane-in"
        data-nodrag="1"
        aria-label={session ? t('canvas.pane.inAria', { name }) : t('canvas.pane.inEmptyAria')}
        title={t('canvas.pane.inTitle')}
        onClick={() => setToken((n) => n + 1)}
      />
      <span className="cv-pane-resize" data-resize="1" aria-hidden="true" />
    </div>
  );
});
