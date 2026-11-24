// Building blocks of the Clip Studio page: ratio frames and picker, the preset list, the clip queue.
import { useEffect, useRef, useState } from 'react';
import { CLIP_OUTRO_MAX, CLIP_STAGES, type ClipJob, type ClipOutro, type ClipOutroPhrase, type ClipPreset, type ClipQueueItem, type RunnerState } from '../../../shared/protocol';
import { RATIO_INFO, clipSettingsLabel, outroDefaultName, outroLine, outroProblem, outroSlotsLeft, jobStatusLine, queueStatusLine, ratioFrame, ratioTitle, readyJobs, settingsSummary, type Ratio } from '../clipForm';

const RATIOS: Ratio[] = ['16:9', '9:16', '1:1'];

/** A frame drawn in the true proportion of the ratio, inside a square box of `box` px. Colour follows the text colour. */
export function RatioFrame({ ratio, box = 36 }: { ratio: Ratio; box?: number }) {
  const { w, h } = ratioFrame(ratio, box - 4);
  return (
    <svg className="cl-frame" data-ratio={ratio} width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden="true" focusable="false">
      <rect x={(box - w) / 2} y={(box - h) / 2} width={w} height={h} rx={Math.max(1, box / 14)} />
    </svg>
  );
}

export function RatioPicker({ value, onPick }: { value: Ratio; onPick: (r: Ratio) => void }) {
  return (
    <div className="cl-ratios" role="group" aria-label="สัดส่วนภาพ">
      {RATIOS.map((r) => {
        const info = RATIO_INFO[r];
        return (
          <button key={r} type="button" className="cl-ratio" aria-pressed={value === r} onClick={() => onPick(r)}>
            <span className="cl-ratio-art">
              <RatioFrame ratio={r} box={52} />
            </span>
            <b>
              {info.name} {r}
            </b>
            <span>{info.platforms}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---- ending (outro) ----

export interface OutroPanelProps {
  outro: ClipOutro;
  saved: ClipOutroPhrase[];
  disabled: boolean;
  onChange: (o: ClipOutro) => void;
  onSave: (text: string, name: string) => Promise<boolean>;
  onRename: (p: ClipOutroPhrase, name: string) => Promise<boolean>;
  onDelete: (p: ClipOutroPhrase) => Promise<void>;
}

export function OutroPanel({ outro, saved, disabled, onChange, onSave, onRename, onDelete }: OutroPanelProps) {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  useEffect(() => {
    if (confirmDel === null) return;
    const t = setTimeout(() => setConfirmDel(null), 5000); // an unconfirmed delete cancels itself
    return () => clearTimeout(t);
  }, [confirmDel]);

  const len = [...outro.text].length;
  const problem = outroProblem(outro);
  const typed = outro.text.trim() !== '';
  const full = outroSlotsLeft(saved) === 0;
  const dup = typed && saved.some((s) => s.text.trim() === outro.text.trim());
  return (
    <div className="cl-outro" aria-label="ท้ายคลิป">
      <div className="cl-chips">
        <button type="button" className="cl-chip" aria-pressed={outro.on} onClick={() => onChange({ ...outro, on: !outro.on })}>
          {outro.on ? 'มีท้ายคลิป' : 'ไม่มีท้ายคลิป'}
        </button>
        <span className="cc-muted">ฉากสุดท้าย ~3–5 วิ (นับรวมในความยาวที่เลือก) แสดงข้อความนี้บนจอ{outro.on ? ' และให้ผู้พากย์อ่านถ้าเปิดเสียงพากย์' : ''}</span>
      </div>
      {outro.on && (
        <>
          <textarea
            id="outro-text"
            className="cc-input"
            aria-label="ข้อความท้ายคลิป"
            value={outro.text}
            rows={3}
            placeholder={'เช่น กดติดตามช่องไว้ได้เลย\nสอบถาม LINE: @yourshop'}
            onChange={(e) => onChange({ ...outro, text: e.target.value })}
          />
          <div className={`cl-outro-count${len > CLIP_OUTRO_MAX ? ' is-over' : ''}`}>
            {len}/{CLIP_OUTRO_MAX}
            {problem ? ` · ${problem}` : ''}
          </div>
        </>
      )}
      <div className="cl-group">
        <div className="cl-grouplabel">คำท้ายที่บันทึกไว้ ({saved.length}/50)</div>
        {saved.length === 0 && <span className="cc-muted">ยังไม่มี — พิมพ์ข้อความแล้วกด "บันทึกคำท้ายนี้"</span>}
        <div className="cl-outrosaved">
          {saved.map((p) => (
            <span key={p.id} className="cl-outrochip" data-on={outro.on && outro.text.trim() === p.text.trim()}>
              {renaming === p.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void onRename(p, renameText).then((ok) => ok && setRenaming(null));
                  }}
                >
                  <input className="cc-input" aria-label="ชื่อคำท้าย" value={renameText} maxLength={40} autoFocus onChange={(e) => setRenameText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />
                  <button type="submit" className="cc-btn is-primary" disabled={renameText.trim() === ''}>
                    บันทึก
                  </button>
                  <button type="button" className="cc-btn" onClick={() => setRenaming(null)}>
                    ยกเลิก
                  </button>
                </form>
              ) : (
                <>
                  <button type="button" title={p.text} onClick={() => onChange({ on: true, text: p.text })}>
                    {p.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`เปลี่ยนชื่อ ${p.name}`}
                    onClick={() => {
                      setRenaming(p.id);
                      setRenameText(p.name);
                    }}
                  >
                    เปลี่ยนชื่อ
                  </button>
                  {confirmDel === p.id ? (
                    <button
                      type="button"
                      className="is-danger"
                      disabled={disabled}
                      onClick={() => {
                        setConfirmDel(null);
                        void onDelete(p);
                      }}
                    >
                      ยืนยันลบ
                    </button>
                  ) : (
                    <button type="button" aria-label={`ลบ ${p.name}`} onClick={() => setConfirmDel(p.id)}>
                      ลบ
                    </button>
                  )}
                </>
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="cl-inline">
        <input className="cc-input" aria-label="ชื่อคำท้าย (ไม่บังคับ)" value={name} maxLength={40} placeholder={typed ? `ชื่อ (ไม่ใส่ = "${outroDefaultName(outro.text)}")` : 'ชื่อ (ไม่บังคับ)'} onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          className="cc-btn"
          disabled={disabled || !typed || full || dup || len > CLIP_OUTRO_MAX}
          title={full ? 'เต็ม 50 อันแล้ว ลบอันเก่าก่อน' : dup ? 'มีคำท้ายนี้อยู่แล้ว' : undefined}
          onClick={() => void onSave(outro.text, name).then((ok) => ok && setName(''))}
        >
          บันทึกคำท้ายนี้
        </button>
      </div>
    </div>
  );
}

// ---- presets ----

export interface PresetPanelProps {
  presets: ClipPreset[];
  selectedId: string | null;
  modified: boolean; // the form differs from the selected preset
  currentName: string; // suggested name for a new preset
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onSave: (name: string) => Promise<boolean>;
  onUpdate: (p: ClipPreset) => Promise<void>;
  onRename: (p: ClipPreset, name: string) => Promise<boolean>;
  onDelete: (p: ClipPreset) => Promise<void>;
}

export function PresetPanel(props: PresetPanelProps) {
  const { presets, selectedId, modified, disabled } = props;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) nameRef.current?.select();
  }, [naming]);
  useEffect(() => {
    if (confirmDel === null) return;
    const t = setTimeout(() => setConfirmDel(null), 5000); // an unconfirmed delete cancels itself
    return () => clearTimeout(t);
  }, [confirmDel]);

  const startNaming = () => {
    setName(props.currentName);
    setNaming(true);
  };
  const submitNew = async () => {
    if (name.trim() === '') return;
    if (await props.onSave(name.trim())) setNaming(false);
  };

  return (
    <div className="cl-presets">
      <div className="cl-sidehead">
        <h2>ชุดตั้งค่า</h2>
        <span className="cc-muted">{presets.length} ชุด</span>
      </div>
      <button type="button" className="cl-preset cl-preset-none" aria-pressed={selectedId === null} onClick={() => props.onSelect(null)}>
        <span className="cl-preset-main">
          <b>ตั้งค่าเอง</b>
          <span>ไม่ใช้ชุด — ปรับทุกค่าเอง</span>
        </span>
      </button>
      <ul className="cl-presetlist">
        {presets.map((p) => {
          const on = p.id === selectedId;
          return (
            <li key={p.id} className="cl-presetitem" data-on={on}>
              {renaming === p.id ? (
                <form
                  className="cl-inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void props.onRename(p, renameText).then((ok) => ok && setRenaming(null));
                  }}
                >
                  <input className="cc-input" aria-label="ชื่อชุด" value={renameText} maxLength={60} autoFocus onChange={(e) => setRenameText(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />
                  <button type="submit" className="cc-btn is-primary" disabled={renameText.trim() === ''}>
                    บันทึก
                  </button>
                  <button type="button" className="cc-btn" onClick={() => setRenaming(null)}>
                    ยกเลิก
                  </button>
                </form>
              ) : (
                <button type="button" className="cl-preset" aria-pressed={on} onClick={() => props.onSelect(p.id)}>
                  <span className="cl-preset-main">
                    <b>{p.name}</b>
                    <span>{settingsSummary(p.settings)}</span>
                    {p.suggested && <em>แนะนำจากคลิปที่เคยทำ — แก้ไขได้</em>}
                  </span>
                </button>
              )}
              {on && renaming !== p.id && (
                <div className="cl-presetacts">
                  {modified && (
                    <button type="button" className="cc-btn is-accent" disabled={disabled} onClick={() => void props.onUpdate(p)}>
                      อัปเดตชุดจากค่าปัจจุบัน
                    </button>
                  )}
                  <button
                    type="button"
                    className="cc-btn"
                    onClick={() => {
                      setRenaming(p.id);
                      setRenameText(p.name);
                    }}
                  >
                    เปลี่ยนชื่อ
                  </button>
                  {confirmDel === p.id ? (
                    <>
                      <button
                        type="button"
                        className="cc-btn is-danger"
                        disabled={disabled}
                        onClick={() => {
                          setConfirmDel(null);
                          void props.onDelete(p);
                        }}
                      >
                        ยืนยันลบชุดนี้
                      </button>
                      <button type="button" className="cc-btn" onClick={() => setConfirmDel(null)}>
                        ยกเลิก
                      </button>
                    </>
                  ) : (
                    <button type="button" className="cc-btn" onClick={() => setConfirmDel(p.id)}>
                      ลบ
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {naming ? (
        <form
          className="cl-inline cl-newpreset"
          onSubmit={(e) => {
            e.preventDefault();
            void submitNew();
          }}
        >
          <label className="cc-muted" htmlFor="preset-name">
            ชื่อชุดใหม่ (เก็บค่าที่ตั้งอยู่ตอนนี้ทั้งหมด)
          </label>
          <input id="preset-name" ref={nameRef} className="cc-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(false)} />
          <div className="cl-presetacts">
            <button type="submit" className="cc-btn is-primary" disabled={disabled || name.trim() === ''}>
              บันทึกชุด
            </button>
            <button type="button" className="cc-btn" onClick={() => setNaming(false)}>
              ยกเลิก
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="cc-btn cl-addpreset" disabled={disabled} onClick={startNaming}>
          + บันทึกชุดใหม่
        </button>
      )}
    </div>
  );
}

// ---- queue ----

export function StageDots({ job }: { job: ClipJob }) {
  return (
    <ol className="cl-dots" aria-label="ขั้นของงาน">
      {CLIP_STAGES.map((label, k) => {
        const done = k < job.stage || (job.ready && k === job.stage);
        const cur = k === job.stage && !job.ready;
        return (
          <li key={label} className={done ? 'is-done' : cur ? 'is-cur' : ''} title={label}>
            <i aria-hidden="true" />
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export interface QueuePanelProps {
  jobs: ClipJob[];
  waiting: ClipQueueItem[];
  presets: ClipPreset[];
  runners: Record<string, RunnerState>;
  onRender: (j: ClipJob) => Promise<void>;
  onRenderAll: (jobs: ClipJob[]) => Promise<void>;
  onRemove: (q: ClipQueueItem) => Promise<void>;
}

export function QueuePanel({ jobs, waiting, presets, runners, onRender, onRenderAll, onRemove }: QueuePanelProps) {
  const ready = readyJobs(jobs);
  const [confirmAll, setConfirmAll] = useState(false);
  useEffect(() => {
    if (!confirmAll) return;
    const t = setTimeout(() => setConfirmAll(false), 6000);
    return () => clearTimeout(t);
  }, [confirmAll]);
  useEffect(() => {
    if (confirmAll && ready.length === 0) setConfirmAll(false);
  }, [confirmAll, ready.length]);

  const isAlive = (j: ClipJob) => runners[j.sessionId]?.alive === true; // no runner entry = its child is gone (server restarted, or closed)
  const working = jobs.filter((j) => !j.ready && isAlive(j)).length;
  return (
    <div className="cl-queuebox">
      <div className="cl-sidehead">
        <h2>คิวงานคลิป</h2>
        <span className="cc-muted">
          กำลังทำ {working} · รอคิว {waiting.length} · พร้อม {ready.length}
        </span>
      </div>
      {ready.length > 0 && (
        <div className="cl-renderall">
          {confirmAll ? (
            <>
              <button
                type="button"
                className="cc-btn is-danger"
                onClick={() => {
                  setConfirmAll(false);
                  void onRenderAll(ready);
                }}
              >
                ยืนยัน render {ready.length} คลิป
              </button>
              <button type="button" className="cc-btn" onClick={() => setConfirmAll(false)}>
                ยกเลิก
              </button>
            </>
          ) : (
            <button type="button" className="cc-btn is-accent" onClick={() => setConfirmAll(true)}>
              render ทุกอันที่พร้อม ({ready.length})
            </button>
          )}
          <span className="cc-muted">render กินเวลาและเครื่อง จะเริ่มเมื่อคุณกดเท่านั้น</span>
        </div>
      )}
      {jobs.length === 0 && waiting.length === 0 && <div className="cc-muted">ยังไม่มีงาน พิมพ์หัวข้อแล้วกด Enter เพื่อเข้าคิว</div>}
      <ul className="cl-qlist">
        {jobs.map((j) => {
          const st = jobStatusLine(j, isAlive(j));
          const isReady = j.ready && !j.renderRequested;
          return (
            <li key={j.sessionId} className={`cl-qitem${isReady ? ' is-ready' : ''}`}>
              <div className="cl-qhead">
                <div className="cl-qtext">
                  <h3>{j.topic}</h3>
                  <div className="cc-muted">{clipSettingsLabel(presets, j.settings, j.styleId, j.styleName)}</div>
                  {outroLine(j.settings) && <div className="cl-qoutro">{outroLine(j.settings)}</div>}
                </div>
              </div>
              <StageDots job={j} />
              <div className={`cl-qstatus is-${st.tone}`} role="status">
                {st.text}
              </div>
              <div className="cl-qacts">
                {isReady && (
                  <button type="button" className="cc-btn is-accent" onClick={() => void onRender(j)}>
                    สั่ง render
                  </button>
                )}
                <a className="cc-btn" href="/" title="ดูงานนี้ในโครงข่ายที่หน้า Control Room">
                  ดูในโครงข่ายงาน
                </a>
              </div>
            </li>
          );
        })}
        {waiting.map((q, i) => (
          <li key={q.id} className={`cl-qitem is-waiting${q.error ? ' is-failed' : ''}`}>
            <div className="cl-qhead">
              <div className="cl-qtext">
                <h3>{q.topic}</h3>
                <div className="cc-muted">{clipSettingsLabel(presets, q.settings, q.styleId, q.styleName)}</div>
                {outroLine(q.settings) && <div className="cl-qoutro">{outroLine(q.settings)}</div>}
              </div>
              <button type="button" className="cl-x" aria-label={`เอา "${q.topic}" ออกจากคิว`} title="เอาออกจากคิว" onClick={() => void onRemove(q)}>
                ×
              </button>
            </div>
            <div className={`cl-qstatus ${q.error ? 'is-stop' : 'is-wait'}`} role="status">
              {queueStatusLine(q, i + 1)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { ratioTitle };
