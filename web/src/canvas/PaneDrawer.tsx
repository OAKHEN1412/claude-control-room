// Right-edge slide-out drawer: a work pane in screen space for a block that has no pane node yet.
// "ปักลง canvas" turns it into a pane node connected to that block.
import { limitText } from '../limit';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { RunnerState, SessionInfo } from '../../../shared/protocol';
import type { Command } from '../components/Controls';
import { STATUS_VAR } from '../components/graphLayout';
import { useT } from '../i18n';
import { statusWord } from './canvasLayout';
import { CloseIcon, PinIcon } from './icons';
import { PaneView } from './PaneView';
import { AccountChip } from '../components/AccountChip';
import { isLocalJob } from '../accountJobLogic';
import type { PaneSource } from './paneStore';

export const DRAWER_MIN_W = 320;
export const SLIDE_MS = 200;

/** Default width: about 40% of the canvas, kept inside sane bounds. */
export function drawerWidth(total: number, stored: number | null): number {
  const max = Math.max(DRAWER_MIN_W, Math.floor(total * 0.85));
  const w = stored ?? Math.round(total * 0.4);
  return Math.min(max, Math.max(DRAWER_MIN_W, w));
}

export interface PaneDrawerProps {
  source: PaneSource;
  session: SessionInfo | null;
  sessions: SessionInfo[];
  runner?: RunnerState;
  command?: Command;
  /** Width of the area the drawer slides over (the canvas). */
  total: number;
  closing: boolean;
  onClose: () => void;
  onPin: () => void;
  onConnect: (sessionId: string) => void;
  onClearAgent: () => void;
  onFullScreen: (sessionId: string) => void;
}

export function PaneDrawer(p: PaneDrawerProps) {
  const [stored, setStored] = useState<number | null>(null);
  const width = drawerWidth(p.total, stored);
  const drag = useRef<{ sx: number; w: number } | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = useT();
  const { session } = p;
  const agent = session && p.source.agentId ? session.subagents.find((a) => a.id === p.source.agentId) : undefined;
  const status = agent ? agent.status : session?.status;
  const limit = agent ? null : limitText(session, p.runner);
  const name = session ? (session.title && session.title !== '(ไม่มีชื่อ)' ? session.title : session.name) : t('canvas.drawer.gone');

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { sx: e.clientX, w: width };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) setStored(drawerWidth(p.total, d.w + (d.sx - e.clientX)));
  };
  const up = () => {
    drag.current = null;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setStored(drawerWidth(p.total, width + 32));
    else if (e.key === 'ArrowRight') setStored(drawerWidth(p.total, width - 32));
    else return;
    e.preventDefault();
  };

  return (
    <aside
      ref={rootRef}
      className={`cv-drawer${p.closing ? ' is-closing' : ''}${limit ? ' is-limit' : ''}`}
      data-chrome="1"
      data-drawer="1"
      role="complementary"
      aria-label={t('canvas.drawer.aria', { name })}
      style={{ width, ['--slide' as string]: `${SLIDE_MS}ms` }}
    >
      <div
        className="cv-drawer-edge"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('canvas.drawer.resize')}
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      />
      <header className="cv-drawer-head">
        <span className="cv-pane-dot" style={{ background: status ? STATUS_VAR[status] : 'var(--idle)' }} aria-hidden="true" />
        <span className="cv-pane-name">{name}</span>
        <span className="cv-pane-sub">{limit ?? (agent ? `subagent · ${agent.description}` : session ? statusWord(session.status) : '')}</span>
        {session && isLocalJob(session, p.runner) && (
          <span className="cv-drawer-acct">
            <AccountChip sessionId={session.sessionId} runner={p.runner} />
          </span>
        )}
        <button type="button" className="cv-drawer-pin" onClick={p.onPin} disabled={!session} title={t('canvas.drawer.pinHint')}>
          <PinIcon />
          {t('canvas.drawer.pin')}
        </button>
        <button type="button" className="cv-pane-x" aria-label={t('canvas.drawer.close')} title={t('canvas.drawer.closeEsc')} onClick={p.onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="cv-drawer-body">
        <PaneView
          source={p.source}
          session={session}
          sessions={p.sessions}
          runner={p.runner}
          command={p.command}
          active={!p.closing}
          onConnect={p.onConnect}
          onDisconnect={p.onClose}
          onClearAgent={p.onClearAgent}
          onFullScreen={p.onFullScreen}
        />
      </div>
    </aside>
  );
}
