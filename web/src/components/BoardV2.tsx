import { useState, type ReactNode } from 'react';
import { Canvas, type CanvasProps } from '../canvas/Canvas';
import { FLOAT_IDS2, coverRightPct, type FloatId2, type Rect, type StoredLayout2 } from '../layoutV2';
import { snapRectToMonitor } from '../canvas/seams';
import { Widget } from './Widget';

export interface BoardV2Props {
  layout: StoredLayout2;
  titles: Record<FloatId2, string>;
  panes: Record<FloatId2, ReactNode>;
  stacked: boolean;
  onRect: (id: FloatId2, rect: Rect) => void;
  onCommit: () => void;
  onHidden: (id: FloatId2, hidden: boolean) => void;
  canvas: Omit<CanvasProps, 'insetRightPct' | 'dock' | 'seams'>;
  /** Several monitors (?seams=): client-x of each boundary and the window width. Floating widgets never straddle one. */
  seams?: readonly number[];
  windowWidth?: number;
}

/** UI v2: the canvas fills the board (work panes are nodes on it); summary and clip float over it and can be hidden / shown from the dock. */
export function BoardV2({ layout, titles, panes, stacked, onRect, onCommit, onHidden, canvas, seams = [], windowWidth = 0 }: BoardV2Props) {
  const [top, setTop] = useState<FloatId2>('summary');

  const dock = (
    <>
      <span className="cv-dock-label">ช่องบนหน้าจอ</span>
      {FLOAT_IDS2.map((id) => (
        <button
          key={id}
          type="button"
          className="cv-btn"
          aria-pressed={!layout.hidden[id]}
          title={layout.hidden[id] ? `แสดง ${titles[id]}` : `ซ่อน ${titles[id]}`}
          onClick={() => {
            onHidden(id, !layout.hidden[id]);
            if (layout.hidden[id]) setTop(id);
          }}
        >
          {titles[id]}
        </button>
      ))}
    </>
  );

  return (
    <main className="cr-board cr-board--v2" data-board="1">
      <Canvas {...canvas} seams={seams} insetRightPct={stacked ? 0 : coverRightPct(layout)} dock={dock} />
      {FLOAT_IDS2.filter((id) => !layout.hidden[id]).map((id) => (
        <Widget
          key={id}
          title={titles[id]}
          rect={snapRectToMonitor(layout.rects[id], seams, windowWidth)}
          z={top === id ? 12 : 10}
          stacked={stacked}
          onChange={(r) => onRect(id, r)}
          onCommit={onCommit}
          onRaise={() => setTop(id)}
          onHide={() => onHidden(id, true)}
        >
          {panes[id]}
        </Widget>
      ))}
    </main>
  );
}
