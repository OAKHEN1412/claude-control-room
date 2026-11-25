import { useId, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { SNAP, moveRect, resizeRect, type Rect } from '../layout';
import { useT } from '../i18n';

export interface WidgetProps {
  title: string; // Thai title shown in the title bar
  rect: Rect; // percent of the board
  z: number;
  stacked: boolean; // narrow screens: static block, no handles
  className?: string;
  onChange: (rect: Rect) => void; // live update while dragging or nudging
  onCommit: () => void; // persist after pointer up / key up
  onRaise: () => void;
  onHide?: () => void; // v2: adds a hide button to the title bar
  children: ReactNode;
}

type Mode = 'move' | 'size';
interface Drag {
  mode: Mode;
  sx: number;
  sy: number;
  start: Rect;
  bw: number;
  bh: number;
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function Widget({ title, rect, z, stacked, className, onChange, onCommit, onRaise, onHide, children }: WidgetProps) {
  const t = useT();
  const drag = useRef<Drag | null>(null);
  const hintId = useId();

  const begin = (mode: Mode) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; drag still works without it */
    }
    const board = el.closest('[data-board]') as HTMLElement | null;
    const br = board?.getBoundingClientRect();
    drag.current = {
      mode,
      sx: e.clientX,
      sy: e.clientY,
      start: rect,
      bw: br?.width || window.innerWidth,
      bh: br?.height || window.innerHeight,
    };
    onRaise();
  };

  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = ((e.clientX - d.sx) / d.bw) * 100;
    const dy = ((e.clientY - d.sy) / d.bh) * 100;
    onChange(d.mode === 'move' ? moveRect(d.start, dx, dy) : resizeRect(d.start, dx, dy));
  };

  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    onCommit();
  };

  const nudge = (mode: Mode) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault();
    const resize = mode === 'size' || e.shiftKey;
    const step = resize ? resizeRect : moveRect;
    onChange(step(rect, dir[0] * SNAP, dir[1] * SNAP));
    onRaise();
  };

  const release = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key.startsWith('Arrow')) onCommit();
  };

  const style = stacked
    ? undefined
    : { left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%`, zIndex: z };

  return (
    <div className={`cr-w${stacked ? ' cr-w--static' : ''}${className ? ` ${className}` : ''}`} style={style}>
      <section className="cr-card" aria-label={title}>
        <div className="cr-head">
          {!stacked && (
            <button
              type="button"
              className="cr-grip"
              aria-label={t('shell.widget.move', { title })}
              aria-describedby={hintId}
              onPointerDown={begin('move')}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onKeyDown={nudge('move')}
              onKeyUp={release}
            >
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <circle cx="4" cy="3" r="1.3" />
                <circle cx="10" cy="3" r="1.3" />
                <circle cx="4" cy="7" r="1.3" />
                <circle cx="10" cy="7" r="1.3" />
                <circle cx="4" cy="11" r="1.3" />
                <circle cx="10" cy="11" r="1.3" />
              </svg>
            </button>
          )}
          {!stacked && (
            <span id={hintId} className="cr-sr">
              {t('shell.widget.keysHint')}
            </span>
          )}
          <h2 className="cr-title">{title}</h2>
          {onHide && (
            <button type="button" className="cr-hide" aria-label={t('shell.widget.hide', { title })} title={t('shell.widget.hideTitle')} onClick={onHide}>
              <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          )}
        </div>
        <div className="cr-content">{children}</div>
        {!stacked && (
          <button
            type="button"
            className="cr-size"
            aria-label={t('shell.widget.resize', { title })}
            onPointerDown={begin('size')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={nudge('size')}
            onKeyUp={release}
          >
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M11 4L4 11M11 8l-3 3" />
            </svg>
          </button>
        )}
      </section>
    </div>
  );
}
