import { CLIP_STAGES, type ClipJob, type SessionInfo } from '../../../shared/protocol';
import './control.css';
import './clip.css';

export interface ClipWidgetProps {
  jobs: ClipJob[];
  sessions: SessionInfo[];
}

/** Control Room widget: clip jobs with their stage, and the way into Clip Studio. */
export function ClipWidget({ jobs, sessions }: ClipWidgetProps) {
  return (
    <div className="cl-widget">
      <a className="cc-btn is-primary cl-open" href="/clip">
        เปิด Clip Studio
      </a>
      {jobs.length === 0 && <p className="cc-muted">ยังไม่มีงานคลิป</p>}
      <ul className="cl-joblist">
        {jobs.map((j) => {
          const s = sessions.find((x) => x.sessionId === j.sessionId);
          return (
            <li key={j.sessionId} className={`cl-jobrow${j.ready && !j.renderRequested ? ' is-ready' : ''}`}>
              <b>{j.topic}</b>
              <span className="cc-muted">
                {j.renderRequested ? 'สั่ง render แล้ว' : j.ready ? 'พร้อม render — รอคุณสั่ง' : `ขั้น ${j.stage + 1}/5 ${CLIP_STAGES[j.stage]}`}
                {s ? ` · ${s.status === 'running' ? 'กำลังทำ' : s.status === 'waiting' ? 'รอคุณ' : s.status === 'done' ? 'เสร็จ' : 'ว่าง'}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
