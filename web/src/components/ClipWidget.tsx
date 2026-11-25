import { type ClipJob, type SessionInfo } from '../../../shared/protocol';
import { stageLabel } from '../clipForm';
import { useT } from '../i18n';
import './control.css';
import './clip.css';

export interface ClipWidgetProps {
  jobs: ClipJob[];
  sessions: SessionInfo[];
}

/** Control Room widget: clip jobs with their stage, and the way into Clip Studio. */
export function ClipWidget({ jobs, sessions }: ClipWidgetProps) {
  const t = useT();
  return (
    <div className="cl-widget">
      <a className="cc-btn is-primary cl-open" href="/clip">
        {t('clip.widget.open')}
      </a>
      {jobs.length === 0 && <p className="cc-muted">{t('clip.widget.empty')}</p>}
      <ul className="cl-joblist">
        {jobs.map((j) => {
          const s = sessions.find((x) => x.sessionId === j.sessionId);
          return (
            <li key={j.sessionId} className={`cl-jobrow${j.ready && !j.renderRequested ? ' is-ready' : ''}`}>
              <b>{j.topic}</b>
              <span className="cc-muted">
                {j.renderRequested ? t('clip.widget.renderOrdered') : j.ready ? t('clip.form.readyWait') : t('clip.widget.stage', { n: j.stage + 1, stage: stageLabel(j.stage) })}
                {s ? ` · ${s.status === 'running' ? t('clip.widget.running') : s.status === 'waiting' ? t('clip.widget.waiting') : s.status === 'done' ? t('clip.widget.done') : t('clip.widget.idle')}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
