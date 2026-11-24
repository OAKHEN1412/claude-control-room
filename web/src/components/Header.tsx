import { useEffect, useState } from 'react';
import { PRESET_NAMES, type PresetName } from '../layout';
import { isLive } from '../useServer';
import type { NotifyPermission } from '../notify';
import { countText } from '../queue';
import type { UiVersion } from '../uiVersion';
import { UsageRings } from './UsageRings';
import type { UsageSnapshot } from '../../../shared/usage';
import type { RunnerState, SessionInfo } from '../../../shared/protocol';
import './v2.css';

export interface HeaderProps {
  machine: string | null;
  connected: boolean;
  lastMessageAt: number | null;
  demo: boolean;
  running: number;
  waiting: number;
  preset: PresetName | 'custom';
  onPreset: (name: PresetName) => void;
  onNewJob?: () => void;
  newJobOpen?: boolean;
  queueCount?: number;
  onBell?: () => void;
  notify?: NotifyPermission;
  onEnableNotify?: () => void;
  sound?: boolean;
  onToggleSound?: () => void;
  uiVersion?: UiVersion;
  onUiVersion?: (v: UiVersion) => void;
  usage?: UsageSnapshot;
  sessions?: SessionInfo[];
  runners?: Record<string, RunnerState>;
  selectedSessionId?: string | null;
}

const PRESET_LABEL: Record<PresetName, string> = {
  standard: 'มาตรฐาน',
  'graph-big': 'โครงข่ายใหญ่',
  'chat-big': 'แชทใหญ่',
};

function clock(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}

export function Header({ machine, connected, lastMessageAt, demo, running, waiting, preset, onPreset, onNewJob, newJobOpen, queueCount = 0, onBell, notify = 'unsupported', onEnableNotify, sound = false, onToggleSound, uiVersion, onUiVersion, usage, sessions = [], runners = {}, selectedSessionId = null }: HeaderProps) {
  const now = useNow(1000);
  const live = isLive(connected, lastMessageAt, now);
  const liveText = lastMessageAt === null ? 'สด' : `สด · อัปเดตล่าสุด ${clock(lastMessageAt)}`;
  const staleText = lastMessageAt === null ? 'ขาดการเชื่อมต่อ · ยังไม่มีข้อมูล' : `ขาดการเชื่อมต่อ · ข้อมูลล่าสุด ${clock(lastMessageAt)}`;

  return (
    <header className="cr-header">
      <div className="cr-brand">
        <h1>Claude Control Room</h1>
        <span className="cr-mono cr-muted">{machine ?? '—'}</span>
      </div>

      {demo ? (
        <span className="cr-pill is-demo" role="status">
          โหมดตัวอย่าง (?demo=1)
        </span>
      ) : (
        <span className={`cr-pill ${live ? 'is-live' : 'is-stale'}`} role="status">
          <span className={`cr-dot${live ? ' cr-live' : ''}`} aria-hidden="true" />
          {live ? liveText : staleText}
        </span>
      )}

      <span className="cr-counts">
        กำลังทำ <b className="cr-mono">{running}</b> · รอคุณ <b className="cr-mono">{waiting}</b>
      </span>

      {usage && <UsageRings usage={usage} sessions={sessions} runners={runners} selectedSessionId={selectedSessionId} now={now} />}

      <div className="cr-controls">
        <span className="cr-sr" role="status">
          {countText(queueCount)}
        </span>
        {onBell && (
          <button
            type="button"
            className={`cc-btn cr-bell${queueCount > 0 ? ' has-items' : ''}`}
            onClick={onBell}
            title="เปิดคำถามที่รอตอบ"
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2a4 4 0 0 0-4 4v2.5L2.5 11h11L12 8.5V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0" />
            </svg>
            คำถามรอตอบ <b className="cr-mono">{queueCount}</b>
          </button>
        )}
        {notify === 'default' && onEnableNotify && (
          <button type="button" className="cc-btn" onClick={onEnableNotify}>
            เปิดแจ้งเตือน
          </button>
        )}
        {notify === 'granted' && <span className="cr-muted cr-small">แจ้งเตือนเปิดอยู่</span>}
        {notify === 'denied' && (
          <span className="cr-muted cr-small" title="เปลี่ยนได้ที่การตั้งค่าไซต์ของเบราว์เซอร์">
            แจ้งเตือนถูกบล็อก
          </span>
        )}
        {onToggleSound && (
          <button type="button" className="cc-btn" aria-pressed={sound} onClick={onToggleSound}>
            เสียง: {sound ? 'เปิด' : 'ปิด'}
          </button>
        )}
        {uiVersion && onUiVersion && (
          <div className="cr-seg" role="group" aria-label="เลือกหน้าจอหลัก">
            {(['v1', 'v2'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className="cr-seg-btn"
                aria-pressed={uiVersion === v}
                title={v === 'v1' ? 'หน้าเดิม: กราฟเป็นช่องหนึ่งใน layout' : 'หน้าใหม่: canvas เต็มจอ มีช่องลอยอยู่ด้านบน'}
                onClick={() => onUiVersion(v)}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        <select
          aria-label="เลือกรูปแบบการจัดหน้าจอ"
          className="cr-sel"
          value={preset}
          onChange={(e) => {
            const v = e.target.value as PresetName;
            if ((PRESET_NAMES as readonly string[]).includes(v)) onPreset(v);
          }}
        >
          {preset === 'custom' && (
            <option value="custom" disabled>
              ที่จัดเอง
            </option>
          )}
          {PRESET_NAMES.map((name) => (
            <option key={name} value={name}>
              {PRESET_LABEL[name]}
            </option>
          ))}
        </select>
        <a className="cc-btn cr-link" href="/gallery">
          คลังวิดีโอ
        </a>
        <a className="cc-btn cr-link" href="/clip">
          Clip Studio
        </a>
        {onNewJob && (
          <button type="button" className="cc-btn is-primary" aria-expanded={!!newJobOpen} onClick={onNewJob}>
            + งานใหม่
          </button>
        )}
      </div>
    </header>
  );
}
