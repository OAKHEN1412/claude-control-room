// Small menus opened from the chip in the middle of a wire: a relay link (pause / continue / max / delete)
// and an SSH attachment (detach). Screen-space popovers placed by the canvas.
import { useState, type ReactNode } from 'react';
import type { LinkInfo } from '../../../shared/protocol';
import type { Command } from '../components/Controls';
import { MAX_FORWARDS_MAX, MAX_FORWARDS_MIN, linkActions, parseMaxForwards } from './linkWires';
import { CloseIcon } from './icons';

export function ChipMenu({ x, y, label, onClose, children }: { x: number; y: number; label: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      className="cv-menu cv-chrome"
      data-chrome="1"
      role="dialog"
      aria-label={label}
      style={{ left: x, top: y }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="cv-menu-head">
        <span className="cv-menu-title">{label}</span>
        <button type="button" className="cv-pane-x" aria-label="ปิดเมนู" title="ปิด (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {children}
    </div>
  );
}

export interface LinkMenuProps {
  link: LinkInfo;
  fromName: string;
  toName: string;
  x: number;
  y: number;
  command: Command | undefined;
  onClose: () => void;
}

export function LinkMenu({ link, fromName, toName, x, y, command, onClose }: LinkMenuProps) {
  const act = linkActions(link);
  const [max, setMax] = useState(String(link.maxForwards));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseMaxForwards(max);

  const run = async (fn: () => ReturnType<Command>, closeAfter = true) => {
    if (!command) {
      setError('ยังสั่งงานไม่ได้');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) {
      if (closeAfter) onClose();
    } else setError(r.error ?? 'ทำไม่สำเร็จ ลองอีกครั้ง');
  };

  // The server has no "change max" message: the link is deleted and made again (its counter starts from 0).
  const applyMax = () =>
    run(async () => {
      if (!command || parsed === null) return { ok: false, error: 'ใส่จำนวน 1–50' };
      const d = await command({ type: 'link_delete', linkId: link.id });
      if (!d.ok) return d;
      return command({ type: 'link_create', from: link.from, to: link.to, maxForwards: parsed });
    });

  return (
    <ChipMenu x={x} y={y} label={`${fromName} → ${toName}`} onClose={onClose}>
      <div className="cv-menu-body">
        <div className="cc-muted">
          ส่งต่อแล้ว {link.forwards}/{link.maxForwards} ครั้ง
          {link.paused ? ' · หยุดชั่วคราว' : ''}
        </div>
        {link.error && link.state !== 'ok' && <div className="cv-menu-err">{link.error}</div>}
        <button type="button" className="cc-btn" disabled={busy} onClick={() => run(() => command!({ type: 'link_pause', linkId: link.id, paused: act.pausedNext }))}>
          {act.pauseLabel}
        </button>
        {act.canContinue && (
          <button type="button" className="cc-btn is-accent" disabled={busy} title="นับใหม่จาก 0 แล้วส่งต่อได้อีก" onClick={() => run(() => command!({ type: 'link_resume', linkId: link.id }))}>
            ไปต่อ
          </button>
        )}
        <div className="cv-menu-max">
          <label htmlFor={`cv-max-${link.id}`}>จำนวนครั้งสูงสุด</label>
          <input
            id={`cv-max-${link.id}`}
            className="cc-input"
            type="number"
            inputMode="numeric"
            min={MAX_FORWARDS_MIN}
            max={MAX_FORWARDS_MAX}
            value={max}
            aria-invalid={parsed === null}
            onChange={(e) => setMax(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && parsed !== null && parsed !== link.maxForwards) void applyMax();
            }}
          />
          <button type="button" className="cc-btn" disabled={busy || parsed === null || parsed === link.maxForwards} title="ตั้งค่าใหม่ (เส้นถูกสร้างใหม่ นับจาก 0)" onClick={() => void applyMax()}>
            ตั้ง
          </button>
        </div>
        <button type="button" className="cc-btn is-danger" disabled={busy} onClick={() => run(() => command!({ type: 'link_delete', linkId: link.id }))}>
          ลบเส้น
        </button>
        {error && (
          <div className="cn-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </ChipMenu>
  );
}

export interface AttachMenuProps {
  sessionName: string;
  machineName: string;
  sessionId: string;
  machineId: string;
  x: number;
  y: number;
  command: Command | undefined;
  onClose: () => void;
}

export function AttachMenu({ sessionName, machineName, sessionId, machineId, x, y, command, onClose }: AttachMenuProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detach = async () => {
    if (!command) {
      setError('ยังสั่งงานไม่ได้');
      return;
    }
    setBusy(true);
    const r = await command({ type: 'machine_detach', sessionId, machineId });
    setBusy(false);
    if (r.ok) onClose();
    else setError(r.error ?? 'ทำไม่สำเร็จ ลองอีกครั้ง');
  };
  return (
    <ChipMenu x={x} y={y} label={`${sessionName} ⇢ ${machineName}`} onClose={onClose}>
      <div className="cv-menu-body">
        <div className="cc-muted">งานนี้สั่งงานบนเครื่อง {machineName} ผ่าน SSH ได้</div>
        <button type="button" className="cc-btn is-danger" disabled={busy} onClick={() => void detach()}>
          ยกเลิกเชื่อม
        </button>
        {error && (
          <div className="cn-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </ChipMenu>
  );
}
