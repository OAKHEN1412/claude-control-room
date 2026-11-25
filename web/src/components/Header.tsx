import { useEffect, useState } from 'react';
import { PRESET_NAMES, type PresetName } from '../layout';
import { isLive } from '../useServer';
import type { NotifyPermission } from '../notify';
import { countText } from '../queue';
import type { UiVersion } from '../uiVersion';
import { UsageRings } from './UsageRings';
import { useLang, useT, type TKey } from '../i18n';
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

const PRESET_KEY: Record<PresetName, TKey> = {
  standard: 'shell.header.preset.standard',
  'graph-big': 'shell.header.preset.graphBig',
  'chat-big': 'shell.header.preset.chatBig',
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
  const t = useT();
  const [lang, setLang] = useLang();
  const now = useNow(1000);
  const live = isLive(connected, lastMessageAt, now);
  const liveText = lastMessageAt === null ? t('shell.header.live') : t('shell.header.liveAt', { time: clock(lastMessageAt) });
  const staleText = lastMessageAt === null ? t('shell.header.stale') : t('shell.header.staleAt', { time: clock(lastMessageAt) });

  return (
    <header className="cr-header">
      <div className="cr-brand">
        <h1>Claude Control Room</h1>
        <span className="cr-mono cr-muted">{machine ?? '—'}</span>
      </div>

      {demo ? (
        <span className="cr-pill is-demo" role="status">
          {t('shell.header.demo')}
        </span>
      ) : (
        <span className={`cr-pill ${live ? 'is-live' : 'is-stale'}`} role="status">
          <span className={`cr-dot${live ? ' cr-live' : ''}`} aria-hidden="true" />
          {live ? liveText : staleText}
        </span>
      )}

      <span className="cr-counts">
        {t('shell.header.doing')} <b className="cr-mono">{running}</b> · {t('shell.header.waitingYou')} <b className="cr-mono">{waiting}</b>
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
            title={t('shell.header.openQuestions')}
          >
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2a4 4 0 0 0-4 4v2.5L2.5 11h11L12 8.5V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0" />
            </svg>
            {t('shell.header.questions')} <b className="cr-mono">{queueCount}</b>
          </button>
        )}
        {notify === 'default' && onEnableNotify && (
          <button type="button" className="cc-btn" onClick={onEnableNotify}>
            {t('shell.header.enableNotify')}
          </button>
        )}
        {notify === 'granted' && <span className="cr-muted cr-small">{t('shell.header.notifyOn')}</span>}
        {notify === 'denied' && (
          <span className="cr-muted cr-small" title={t('shell.header.notifyBlockedHint')}>
            {t('shell.header.notifyBlocked')}
          </span>
        )}
        {onToggleSound && (
          <button type="button" className="cc-btn" aria-pressed={sound} onClick={onToggleSound}>
            {sound ? t('shell.header.soundOn') : t('shell.header.soundOff')}
          </button>
        )}
        {uiVersion && onUiVersion && (
          <div className="cr-seg" role="group" aria-label={t('shell.header.layoutGroup')}>
            {(['v1', 'v2'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className="cr-seg-btn"
                aria-pressed={uiVersion === v}
                title={v === 'v1' ? t('shell.header.v1Title') : t('shell.header.v2Title')}
                onClick={() => onUiVersion(v)}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        <select
          aria-label={t('shell.header.presetAria')}
          className="cr-sel"
          value={preset}
          onChange={(e) => {
            const v = e.target.value as PresetName;
            if ((PRESET_NAMES as readonly string[]).includes(v)) onPreset(v);
          }}
        >
          {preset === 'custom' && (
            <option value="custom" disabled>
              {t('shell.header.presetCustom')}
            </option>
          )}
          {PRESET_NAMES.map((name) => (
            <option key={name} value={name}>
              {t(PRESET_KEY[name])}
            </option>
          ))}
        </select>
        <a className="cc-btn cr-link" href="/gallery">
          {t('shell.header.gallery')}
        </a>
        <a className="cc-btn cr-link" href="/clip">
          Clip Studio
        </a>
        {onNewJob && (
          <button type="button" className="cc-btn is-primary" aria-expanded={!!newJobOpen} onClick={onNewJob}>
            {t('shell.header.newJob')}
          </button>
        )}
        <button
          type="button"
          className="cc-btn cr-lang"
          title={t('lang.toggle')}
          aria-label={t('lang.toggle')}
          onClick={() => setLang(lang === 'th' ? 'en' : 'th')}
        >
          {lang === 'th' ? t('lang.en') : t('lang.th')}
        </button>
      </div>
    </header>
  );
}
