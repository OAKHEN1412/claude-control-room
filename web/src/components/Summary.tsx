import { useRef, useState, type FormEvent } from 'react';
import type { RunnerState, SessionInfo, WorklogCard } from '../../../shared/protocol';
import { CHIPS, TODAY_QUESTION, chipAnswer, statusLine, type ChipId } from '../../../shared/observer';
import type { CommandResult } from '../commands';
import { cardTime, cardView } from '../summaryView';
import './summary.css';

export interface SummaryProps {
  sessions: SessionInfo[];
  runners: Record<string, RunnerState>;
  cards: WorklogCard[];
  ask: (question: string) => Promise<CommandResult>;
  offlineReason: string | null; // why the model cannot be asked, null = can
}

type Tab = 'sum' | 'log';
interface Bubble {
  id: number;
  q: string;
  a: string | null; // null while waiting
  via: 'rule' | 'haiku';
  error: boolean;
}

export function Summary({ sessions, runners, cards, ask, offlineReason }: SummaryProps) {
  const [tab, setTab] = useState<Tab>('sum');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const askModel = async (q: string) => {
    const id = ++seq.current;
    setBubbles((b) => [...b, { id, q, a: null, via: 'haiku', error: false }]);
    setBusy(true);
    const r = await ask(q);
    setBusy(false);
    setBubbles((b) =>
      b.map((x) => (x.id === id ? { ...x, a: r.ok && r.answer ? r.answer : (r.error ?? 'ไม่ได้คำตอบ'), error: !r.ok } : x)),
    );
  };

  const onChip = (id: ChipId, label: string) => {
    const local = chipAnswer(id, sessions, runners);
    if (local !== null) {
      // Deterministic: answered here from the live state, no model call.
      setBubbles((b) => [...b, { id: ++seq.current, q: label, a: local, via: 'rule', error: false }]);
      return;
    }
    void askModel(id === 'today' ? TODAY_QUESTION : label);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || busy || offlineReason) return;
    setText('');
    void askModel(q);
  };

  return (
    <div className="cs-root">
      <div className="cs-tabs" role="tablist" aria-label="สรุปและบันทึกงาน">
        <button type="button" role="tab" aria-selected={tab === 'sum'} className={`cs-tab${tab === 'sum' ? ' is-on' : ''}`} onClick={() => setTab('sum')}>
          ผู้ช่วยสรุป
        </button>
        <button type="button" role="tab" aria-selected={tab === 'log'} className={`cs-tab${tab === 'log' ? ' is-on' : ''}`} onClick={() => setTab('log')}>
          บันทึกงาน{cards.length > 0 ? ` (${cards.length})` : ''}
        </button>
      </div>

      {tab === 'sum' ? (
        <div className="cs-body" role="tabpanel" aria-label="ผู้ช่วยสรุป">
          <div className="cs-status" role="status">
            {statusLine(sessions, runners)}
          </div>
          <div className="cs-chips">
            {CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="cs-chip"
                disabled={busy || (c.model && !!offlineReason)}
                onClick={() => onChip(c.id, c.label)}
                title={c.model ? 'ใช้ Haiku' : 'ตอบจากสถานะที่เห็น ไม่เรียกโมเดล'}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="cs-qa" aria-live="polite">
            {bubbles.map((m) => (
              <div key={m.id} className="cs-pair">
                <div className="cs-q">{m.q}</div>
                <div className={`cs-a${m.error ? ' is-error' : ''}`}>{m.a === null ? 'กำลังถาม Haiku…' : m.a}</div>
                {m.a !== null && !m.error && <div className="cs-via">{m.via === 'haiku' ? 'ตอบโดย Haiku' : 'ตอบจากสถานะที่เห็น ไม่เรียกโมเดล'}</div>}
              </div>
            ))}
          </div>
          <form className="cs-ask" onSubmit={onSubmit}>
            <input
              className="cs-input"
              aria-label="ถามผู้ช่วยสรุป"
              placeholder="ถามเรื่องงานที่ทำอยู่"
              value={text}
              maxLength={500}
              onChange={(e) => setText(e.target.value)}
              disabled={!!offlineReason}
            />
            <button type="submit" className="cs-send" disabled={busy || !text.trim() || !!offlineReason}>
              ถาม
            </button>
          </form>
          <div className="cs-note">{offlineReason ?? 'ใช้ Haiku · ไม่แตะงาน — ถามเมื่อกดเท่านั้น'}</div>
        </div>
      ) : (
        <div className="cs-body" role="tabpanel" aria-label="บันทึกงาน">
          {cards.length === 0 && <p className="cs-empty">ยังไม่มีงานที่จบวันนี้ — งานที่เงียบเกิน 2 นาทีหรือปิดแล้วจะขึ้นที่นี่เอง</p>}
          {cards.map((c) => {
            const v = cardView(c);
            return (
              <article key={c.sessionId} className="cs-card">
                <div className="cs-card-head">
                  <h3 className="cs-card-title">{c.title}</h3>
                  <span className="cs-card-time">{cardTime(c.finishedAt)}</span>
                </div>
                <div className={v.resultTone === 'ok' ? 'cs-result' : 'cs-result is-muted'}>{v.resultText}</div>
                {v.bullets.length > 0 ? (
                  <>
                    <div className="cs-bad">ไม่เวิร์ก</div>
                    <ul className="cs-bullets">
                      {v.bullets.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <div className="cs-none">ไม่มีรายการที่ไม่เวิร์ก</div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
