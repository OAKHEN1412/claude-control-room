// Attachment chips (above the text box), the paperclip button and the drop overlay of a message box.
import { useRef } from 'react';
import { formatSize } from '../../../shared/uploads';
import type { Attachments } from './useAttachments';

function FileIcon() {
  return (
    <svg className="at-fileicon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function AttachChips({ att }: { att: Attachments }) {
  if (att.chips.length === 0 && !att.problem) return null;
  return (
    <div className="at-wrap">
      {att.chips.length > 0 && (
        <ul className="at-chips" aria-label="ไฟล์แนบ">
          {att.chips.map((c) => (
            <li key={c.key} className={`at-chip is-${c.status}`} title={c.error ?? `${c.name} (${formatSize(c.size)})`}>
              {c.previewUrl ? <img className="at-thumb" src={c.previewUrl} alt="" /> : <FileIcon />}
              <span className="at-meta">
                <span className="at-name">{c.name}</span>
                <span className="at-size">{c.status === 'uploading' ? 'กำลังอัปโหลด…' : c.status === 'error' ? (c.error ?? 'ไม่สำเร็จ') : formatSize(c.size)}</span>
              </span>
              <button type="button" className="at-x" aria-label={`เอา ${c.name} ออก`} onClick={() => att.remove(c.key)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {att.problem && (
        <div className="cc-error" role="alert">
          {att.problem}
        </div>
      )}
    </div>
  );
}

/** Paperclip button + its hidden file input. Disabled (with the reason as tooltip) when attaching is off. */
export function AttachButton({ att, off }: { att: Attachments; off?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const reason = att.disabled;
  return (
    <>
      <button
        type="button"
        className="cc-btn at-clip"
        aria-label="แนบไฟล์"
        title={reason ?? 'แนบไฟล์ (หรือลากไฟล์มาวาง / วางรูปด้วย Ctrl+V)'}
        disabled={off || reason !== null}
        onClick={() => input.current?.click()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(e) => {
          att.addFiles(Array.from(e.target.files ?? []));
          e.target.value = ''; // the same file can be picked again
        }}
      />
    </>
  );
}

/** Highlight shown while a file is dragged over the box. The parent needs `position: relative`. */
export function DropOverlay({ att }: { att: Attachments }) {
  if (!att.dragging) return null;
  return (
    <div className={`at-drop${att.disabled ? ' is-off' : ''}`} aria-hidden="true">
      {att.disabled ?? 'วางไฟล์ที่นี่'}
    </div>
  );
}
