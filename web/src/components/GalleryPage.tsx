import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { type GalleryItem } from '../../../shared/protocol';
import { apiBase } from '../useServer';
import { filterItems, formatDuration, formatSize, projectNames } from '../galleryView';
import './control.css';
import './gallery.css';

const API = apiBase();

function Thumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="gl-ph">ไม่มีภาพตัวอย่าง</span>;
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function GalleryPage() {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [project, setProject] = useState('');
  const [playing, setPlaying] = useState<GalleryItem | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/gallery`);
      const j = (await r.json()) as { ok?: boolean; items?: GalleryItem[]; error?: string };
      if (!r.ok || j.ok === false || !Array.isArray(j.items)) throw new Error(j.error ?? `HTTP ${r.status}`);
      setItems(j.items);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(`โหลดรายการวิดีโอไม่ได้: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const projects = useMemo(() => projectNames(items), [items]);
  const shown = useMemo(() => filterItems(items, text, project), [items, text, project]);

  const openFolder = async (item: GalleryItem) => {
    setOpenErr(null);
    try {
      const r = await fetch(`${API}/api/gallery/open/${item.id}`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${r.status}`);
    } catch (e) {
      setOpenErr(`เปิดโฟลเดอร์ไม่ได้: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  let body: ReactNode;
  if (loading && items.length === 0) body = <p className="gl-note">กำลังโหลด…</p>;
  else if (items.length === 0) body = <p className="gl-note">ยังไม่พบวิดีโอที่ render แล้ว</p>;
  else if (shown.length === 0) body = <p className="gl-note">ไม่พบวิดีโอที่ตรงกับตัวกรอง</p>;
  else
    body = (
      <div className="gl-grid">
        {shown.map((item) => (
          <button
            key={item.id}
            type="button"
            className="gl-card"
            aria-pressed={playing?.id === item.id}
            onClick={() => {
              setOpenErr(null);
              setPlaying(item);
            }}
          >
            <span className="gl-thumb">
              <Thumb src={`${API}${item.thumbUrl}`} />
            </span>
            <span className="gl-body">
              <span className="gl-title">{item.title}</span>
              <span className="gl-date">{new Date(item.mtimeMs).toLocaleString('th-TH')}</span>
              {item.style && <span className="gl-tag">สไตล์: {item.style}</span>}
              {item.topic && <span className="gl-tag">หัวข้อ: {item.topic}</span>}
              <span className="gl-meta">
                <span className="gl-mono">{formatDuration(item.durationSec)}</span>
                <span className="gl-mono">{formatSize(item.size)}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    );

  return (
    <div className="gl-page">
      <header className="gl-head">
        <a className="cc-btn gl-back" href="/">
          กลับ Control Room
        </a>
        <h1>คลังวิดีโอ</h1>
      </header>

      <div className="gl-toolbar">
        <input
          className="cc-input"
          type="search"
          placeholder="ค้นหาจากชื่อ สไตล์ หรือหัวข้อ"
          aria-label="ค้นหาวิดีโอ"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select className="cc-sel" aria-label="เลือกโปรเจกต์" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">ทุกโปรเจกต์</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button type="button" className="cc-btn" onClick={() => void load()} disabled={loading}>
          รีเฟรช
        </button>
      </div>

      {loadErr && <p className="gl-error">{loadErr}</p>}

      {playing && (
        <section className="gl-player" aria-label="เล่นวิดีโอ">
          <video key={playing.id} controls autoPlay src={`${API}${playing.videoUrl}`} />
          <div className="gl-player-bar">
            <span className="gl-player-title">{playing.title}</span>
            <button type="button" className="cc-btn" onClick={() => void openFolder(playing)}>
              เปิดโฟลเดอร์
            </button>
            <button
              type="button"
              className="cc-btn"
              onClick={() => {
                setPlaying(null);
                setOpenErr(null);
              }}
            >
              ปิด
            </button>
          </div>
          {openErr && <p className="gl-error">{openErr}</p>}
        </section>
      )}

      <div className="gl-grid-area">{body}</div>
    </div>
  );
}
