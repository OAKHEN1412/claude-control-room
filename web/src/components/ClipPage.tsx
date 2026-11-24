import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CLIP_BUILDER_MODELS,
  CLIP_CAST,
  CLIP_SCRIPT_MODELS,
  CLIP_STAGES,
  CLIP_PERMISSION_MODE,
  DEFAULT_EFFORT,
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  type ClipJob,
  type ClipOutro,
  type ClipOutroPhrase,
  type ClipPreset,
  type ClipQueueItem,
  type ClipSettings,
  type EffortLevel,
  type PermissionMode,
} from '../../../shared/protocol';
import { RATIO_INFO, afterQueued, applyPreset, formMatchesPreset, isQueueKey, outroOf, outroProblem, suggestName, type ClipForm } from '../clipForm';
import { jobFlags } from '../control';
import { PermissionModeField, RemoteToggle } from './Controls';
import { OutroPanel, PresetPanel, QueuePanel, RatioPicker } from './ClipParts';
import { apiBase, useServer } from '../useServer';
import './control.css';
import './clip.css';

const API = apiBase();
const LENGTHS: [ClipSettings['length'], string][] = [['30s', '30 วิ'], ['60s', '60 วิ'], ['90s', '90 วิ'], ['3min', '3 นาที']];

interface OursCard { id: string; name: string; note: string; alt: string; stillUrl: string }
interface LemoCard { id: string; name: string; category: string; thumbUrl: string | null }
interface LemoView { installed: boolean; error?: string; categories: string[]; styles: LemoCard[] }
interface Voice { id: string; name: string; builtin: boolean }
interface Config { ours: OursCard[]; lemo: LemoView; voices: Voice[]; voiceModel: string; defaultSample: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, init);
  const j = (await r.json()) as T & { ok?: boolean; error?: string };
  if (!r.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

function Chips<T extends string>({ label, items, value, onPick }: { label: string; items: [T, string][]; value: T; onPick: (v: T) => void }) {
  return (
    <div className="cl-group">
      <div className="cl-grouplabel">{label}</div>
      <div className="cl-chips">
        {items.map(([v, t]) => (
          <button key={v} type="button" className="cl-chip" aria-pressed={value === v} onClick={() => onPick(v)}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ClipPage() {
  const server = useServer();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cfgErr, setCfgErr] = useState<string | null>(null);
  const [topic, setTopic] = useState('');
  const [points, setPoints] = useState('');
  const [length, setLength] = useState<ClipSettings['length']>('60s');
  const [ratio, setRatio] = useState<ClipSettings['ratio']>('16:9');
  const [lang, setLang] = useState<ClipSettings['lang']>('th');
  const [voiceOn, setVoiceOn] = useState(true);
  const [music, setMusic] = useState(true);
  const [cast, setCast] = useState<string[]>(['เทค', 'บอท']);
  const [outro, setOutro] = useState<ClipOutro>({ on: false, text: '' });
  const [outroMsg, setOutroMsg] = useState<string | null>(null);
  const [src, setSrc] = useState<'ours' | 'lemo'>('ours');
  const [cat, setCat] = useState<string>('');
  const [style, setStyle] = useState('ours:whiteboard');
  const [scriptModel, setScriptModel] = useState('sonnet');
  const [builderModel, setBuilderModel] = useState('opus');
  const [permMode, setPermMode] = useState<PermissionMode>(CLIP_PERMISSION_MODE);
  const [bypassOk, setBypassOk] = useState(false);
  const [rc, setRc] = useState(false);
  const [effort, setEffort] = useState<EffortLevel>(DEFAULT_EFFORT);
  const [voice, setVoice] = useState('KhBRXgEQjvfdIyXOu7G3');
  const [sample, setSample] = useState('');
  const [newVoice, setNewVoice] = useState('');
  const [newName, setNewName] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [stills, setStills] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presetMsg, setPresetMsg] = useState<string | null>(null);
  const [renderMsg, setRenderMsg] = useState<string | null>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);

  const load = useCallback(async () => {
    try {
      const c = await api<Config>('/api/clip-config');
      setCfg(c);
      setCfgErr(null);
      setSample((s) => s || c.defaultSample);
      setCat((cur) => (c.lemo.categories.includes(cur) ? cur : (c.lemo.categories[0] ?? '')));
    } catch (e) {
      setCfgErr(`โหลดค่าจากเซิร์ฟเวอร์ไม่ได้: ${(e as Error).message}`);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const reload = async () => {
    try {
      await api('/api/styles/reload', { method: 'POST' });
      await load();
    } catch (e) {
      setCfgErr((e as Error).message);
    }
  };

  const play = async (v: Voice) => {
    if (playing) return;
    setPlaying(v.id);
    setVoiceMsg(null);
    try {
      const r = await api<{ url: string; cached: boolean }>('/api/voice/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: v.id, text: sample }),
      });
      setAudioUrl(`${API}${r.url}`);
      setVoiceMsg(r.cached ? 'เล่นจาก cache (ไม่เสียเครดิต)' : 'สร้างเสียงใหม่จาก ElevenLabs แล้ว');
      setTimeout(() => void audio.current?.play().catch(() => undefined), 50);
    } catch (e) {
      setVoiceMsg((e as Error).message);
    } finally {
      setPlaying(null);
    }
  };

  const addVoice = async () => {
    try {
      const r = await api<{ voices: Voice[] }>('/api/voices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: newVoice.trim(), name: newName.trim() }),
      });
      setCfg((c) => (c ? { ...c, voices: r.voices } : c));
      setVoice(newVoice.trim());
      setNewVoice('');
      setNewName('');
      setVoiceMsg(null);
    } catch (e) {
      setVoiceMsg((e as Error).message);
    }
  };

  const removeVoice = async (id: string) => {
    try {
      const r = await api<{ voices: Voice[] }>(`/api/voices/${id}`, { method: 'DELETE' });
      setCfg((c) => (c ? { ...c, voices: r.voices } : c));
    } catch (e) {
      setVoiceMsg((e as Error).message);
    }
  };

  const styleName = style.startsWith('ours:')
    ? cfg?.ours.find((o) => `ours:${o.id}` === style)?.name
    : cfg?.lemo.styles.find((l) => `lemo:${l.id}` === style)?.name;
  const offline = server.demo ? 'โหมดตัวอย่าง' : server.connected ? null : 'ยังไม่ได้เชื่อมต่อเซิร์ฟเวอร์';
  const canQueue = !offline && topic.trim() !== '' && !!styleName && (!voiceOn || !!voice) && outroProblem(outro) === null;

  const form: ClipForm = useMemo(() => ({ length, ratio, lang, voice: voiceOn, music, cast, outro, style }), [length, ratio, lang, voiceOn, music, cast, outro, style]);
  const presets = server.clipPresets;
  const selected = presets.find((p) => p.id === presetId) ?? null;
  const modified = selected ? !formMatchesPreset(form, selected) : false;
  const expanded = selected === null || settingsOpen;

  const applyForm = useCallback(
    (p: ClipPreset) => {
      const f = applyPreset(form, p);
      setLength(f.length);
      setRatio(f.ratio);
      setLang(f.lang);
      setVoiceOn(f.voice);
      setMusic(f.music);
      setCast(f.cast);
      setOutro(outroOf(f));
      setStyle(f.style);
      setSrc(f.style.startsWith('lemo:') ? 'lemo' : 'ours');
      const lemo = cfg?.lemo.styles.find((l) => `lemo:${l.id}` === f.style);
      if (lemo) setCat(lemo.category);
    },
    [form, cfg],
  );

  const pickPreset = (id: string | null) => {
    setPresetId(id);
    setPresetMsg(null);
    try {
      if (id) localStorage.setItem('cl-preset', id);
      else localStorage.removeItem('cl-preset');
    } catch {
      /* private mode: the choice just is not remembered */
    }
    const p = presets.find((x) => x.id === id);
    if (p) {
      applyForm(p);
      setSettingsOpen(false);
    } else setSettingsOpen(true);
  };

  // Come back to the preset used last time, once the list and the style list have arrived.
  useEffect(() => {
    if (restored.current || presets.length === 0 || !cfg) return;
    restored.current = true;
    let id: string | null = null;
    try {
      id = localStorage.getItem('cl-preset');
    } catch {
      id = null;
    }
    const p = presets.find((x) => x.id === id);
    if (p) {
      setPresetId(p.id);
      applyForm(p);
    }
  }, [presets, cfg, applyForm]);

  const currentSettings = (): ClipSettings => ({ length, ratio, lang, voice: voiceOn, music, cast, ...(outro.on || outro.text.trim() !== '' ? { outro: { on: outro.on, text: outro.text.trim() } } : {}) });

  const savePreset = async (name: string, id?: string): Promise<boolean> => {
    setPresetMsg(null);
    const r = await server.command({ type: 'clip_preset_save', ...(id ? { id } : {}), name, settings: currentSettings(), styleId: style });
    if (!r.ok) {
      setPresetMsg(r.error ?? 'บันทึกชุดไม่ได้');
      return false;
    }
    if (!id && r.sessionId) {
      setPresetId(r.sessionId); // the server answers with the new preset id
      setSettingsOpen(false);
      try {
        localStorage.setItem('cl-preset', r.sessionId);
      } catch {
        /* ignore */
      }
    }
    return true;
  };

  const queueClip = async () => {
    if (!canQueue) return;
    setErr(null);
    const sent = { topic: topic.trim(), points };
    const next = afterQueued({ topic, points }); // cleared at once, every setting stays: the next topic can be typed now
    setTopic(next.topic);
    setPoints(next.points);
    topicRef.current?.focus();
    const r = await server.command({
      type: 'clip_start',
      topic: sent.topic,
      points: sent.points,
      settings: currentSettings(),
      styleId: style,
      voiceId: voiceOn ? voice : null,
      scriptModel,
      builderModel,
      effort,
      ...jobFlags(permMode, bypassOk, rc),
    });
    if (!r.ok) {
      setErr(r.error ?? 'เข้าคิวไม่ได้');
      setTopic((t) => (t === '' ? sent.topic : t)); // give the topic back unless the user already typed the next one
      setPoints((p) => (p === '' ? sent.points : p));
    }
  };

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isQueueKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }, topic)) return;
    e.preventDefault();
    void queueClip();
  };

  const render = async (j: ClipJob) => {
    const r = await server.command({ type: 'clip_render', sessionId: j.sessionId });
    setRenderMsg(r.ok ? null : (r.error ?? 'สั่ง render ไม่ได้'));
  };

  // Only ever called from the confirmed button: one clip_render per clip that is ready and not yet ordered.
  const renderAll = async (jobs: ClipJob[]) => {
    const failed: string[] = [];
    for (const j of jobs) {
      const r = await server.command({ type: 'clip_render', sessionId: j.sessionId });
      if (!r.ok) failed.push(`${j.topic}: ${r.error ?? 'สั่งไม่ได้'}`);
    }
    setRenderMsg(failed.length > 0 ? failed.join(' · ') : null);
  };

  const removeQueued = async (q: ClipQueueItem) => {
    const r = await server.command({ type: 'clip_dequeue', id: q.id });
    setRenderMsg(r.ok ? null : (r.error ?? 'เอาออกจากคิวไม่ได้'));
  };

  const lemoStyles = cfg?.lemo.styles.filter((s) => s.category === cat) ?? [];
  const scriptOpts = MODEL_OPTIONS.filter((o) => (CLIP_SCRIPT_MODELS as readonly string[]).includes(o.id) || o.cli === null);
  const builderOpts = MODEL_OPTIONS.filter((o) => (CLIP_BUILDER_MODELS as readonly string[]).includes(o.id));

  const info = RATIO_INFO[ratio];
  const ours = cfg?.ours.find((o) => `ours:${o.id}` === style);
  const lemoSel = cfg?.lemo.styles.find((l) => `lemo:${l.id}` === style);
  const previewSrc = ours
    ? stills[ours.id] === false
      ? null
      : `${API}${ours.stillUrl}`
    : lemoSel?.thumbUrl
      ? lemoSel.thumbUrl.startsWith('/')
        ? `${API}${lemoSel.thumbUrl}`
        : lemoSel.thumbUrl
      : null;
  const voiceName = cfg?.voices.find((v) => v.id === voice)?.name;
  const lengthLabel = LENGTHS.find((l) => l[0] === length)?.[1];

  return (
    <div className="cl-page">
      <header className="cl-head">
        <a className="cc-btn" href="/">
          กลับ Control Room
        </a>
        <h1>Clip Studio</h1>
        <span className="cc-muted">{server.connected ? 'เชื่อมต่อแล้ว' : 'ขาดการเชื่อมต่อ'}</span>
      </header>
      <div className="cl-body">
        <aside className="cl-side cl-left" aria-label="ชุดตั้งค่า">
          <PresetPanel
            presets={presets}
            selectedId={selected ? selected.id : null}
            modified={modified}
            currentName={suggestName(form, styleName, presets.map((p) => p.name))}
            disabled={!!offline}
            onSelect={pickPreset}
            onSave={(name) => savePreset(name)}
            onUpdate={async (p) => void (await savePreset(p.name, p.id))}
            onRename={(p, name) =>
              server.command({ type: 'clip_preset_save', id: p.id, name, settings: p.settings, styleId: p.styleId }).then((r) => {
                setPresetMsg(r.ok ? null : (r.error ?? 'เปลี่ยนชื่อไม่ได้'));
                return r.ok;
              })
            }
            onDelete={async (p) => {
              const r = await server.command({ type: 'clip_preset_delete', id: p.id });
              if (!r.ok) setPresetMsg(r.error ?? 'ลบชุดไม่ได้');
              else if (p.id === presetId) pickPreset(null);
            }}
          />
          {presetMsg && (
            <div className="cl-err" role="alert">
              {presetMsg}
            </div>
          )}
        </aside>

        <main className="cl-main">
          {cfgErr && (
            <div className="cl-err" role="alert">
              {cfgErr}
            </div>
          )}

          <section className="cl-card" aria-label="หัวข้อ">
            <div className="cl-field">
              <label htmlFor="topic">หัวข้อคลิป</label>
              <input
                id="topic"
                ref={topicRef}
                className="cc-input is-large"
                value={topic}
                placeholder="เช่น FRL unit คืออะไร ใช้ยังไง"
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={onEnter}
                maxLength={200}
                autoFocus
                autoComplete="off"
              />
            </div>
            <div className="cl-field">
              <label htmlFor="points">ประเด็นที่ต้องมี (ไม่บังคับ)</label>
              <input id="points" className="cc-input" value={points} placeholder="คั่นด้วย , เช่น ความหมาย, ตัวอย่าง, ข้อควรระวัง" onChange={(e) => setPoints(e.target.value)} onKeyDown={onEnter} maxLength={1000} autoComplete="off" />
            </div>
            <div className="cl-create">
              <button type="button" className="cc-btn is-primary" disabled={!canQueue} title={offline ?? undefined} onClick={() => void queueClip()}>
                เข้าคิว (Enter)
              </button>
              <span className="cc-muted">
                ใช้ค่า: {selected ? `ชุด "${selected.name}"${modified ? ' (แก้แล้ว)' : ''}` : 'ตั้งเอง'} · {info.name} {ratio} · {lengthLabel}
              </span>
              {err && (
                <span className="cl-err" role="alert">
                  {err}
                </span>
              )}
            </div>
          </section>

          <section className="cl-card cl-previewcard" aria-label="ตัวอย่างสไตล์">
            <div className="cl-preview">{previewSrc ? <img src={previewSrc} alt={`ภาพนิ่งสไตล์ ${styleName ?? ''}`} /> : <span className="cl-ph">[ไม่มีภาพนิ่ง]</span>}</div>
            <div className="cl-previewtext">
              <b>{styleName ?? 'ยังไม่ได้เลือกสไตล์'}</b>
            </div>
          </section>

          <section className="cl-card" aria-label="ค่าปรับ">
            <div className="cl-row">
              <h2>ปรับค่า</h2>
              {selected ? (
                <button type="button" className="cc-btn" aria-expanded={settingsOpen} aria-controls="cl-settings" onClick={() => setSettingsOpen((o) => !o)}>
                  {settingsOpen ? 'ซ่อนค่าปรับ' : 'ปรับค่า…'}
                </button>
              ) : (
                <span className="cc-muted">ไม่ได้ใช้ชุด — ตั้งทุกค่าที่นี่ หรือกด "+ บันทึกชุดใหม่" ทางซ้ายเพื่อเก็บไว้</span>
              )}
            </div>
            {!expanded && (
              <p className="cl-note">
                {[lengthLabel, `${info.name} ${ratio}`, lang === 'th' ? 'ไทย' : 'English', voiceOn ? 'มีเสียงพากย์' : 'ไม่มีเสียงพากย์', music ? 'มีเพลง' : 'ไม่มีเพลง', outro.on ? 'มีท้ายคลิป' : null, styleName].filter(Boolean).join(' · ')}
              </p>
            )}
            <div id="cl-settings" hidden={!expanded} className="cl-settings">
              <Chips label="ความยาว" items={LENGTHS} value={length} onPick={setLength} />
              <div className="cl-group">
                <div className="cl-grouplabel">สัดส่วน</div>
                <RatioPicker value={ratio} onPick={setRatio} />
              </div>
              <Chips label="ภาษา" items={[['th', 'ไทย'], ['en', 'English']]} value={lang} onPick={setLang} />
              <Chips label="เสียง" items={[['on', 'มีเสียงพากย์'], ['off', 'ไม่มีเสียงพากย์']]} value={voiceOn ? 'on' : 'off'} onPick={(v) => setVoiceOn(v === 'on')} />
              <Chips label="เพลง" items={[['on', 'มีเพลง'], ['off', 'ไม่มีเพลง']]} value={music ? 'on' : 'off'} onPick={(v) => setMusic(v === 'on')} />
              <div className="cl-group">
                <div className="cl-grouplabel">ตัวละคร</div>
                <div className="cl-chips">
                  {CLIP_CAST.map((c) => (
                    <button key={c} type="button" className="cl-chip" aria-pressed={cast.includes(c)} onClick={() => setCast((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]))}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <div className="cl-sub" aria-label="ท้ายคลิป">
                <h2>ท้ายคลิป</h2>
                <OutroPanel
                  outro={outro}
                  saved={server.clipOutros}
                  disabled={!!offline}
                  onChange={(o) => {
                    setOutro(o);
                    setOutroMsg(null);
                  }}
                  onSave={async (text, name) => {
                    const r = await server.command({ type: 'clip_outro_save', text, ...(name.trim() !== '' ? { name: name.trim() } : {}) });
                    setOutroMsg(r.ok ? null : (r.error ?? 'บันทึกคำท้ายไม่ได้'));
                    return r.ok;
                  }}
                  onRename={async (p: ClipOutroPhrase, name) => {
                    const r = await server.command({ type: 'clip_outro_save', id: p.id, name: name.trim(), text: p.text });
                    setOutroMsg(r.ok ? null : (r.error ?? 'เปลี่ยนชื่อไม่ได้'));
                    return r.ok;
                  }}
                  onDelete={async (p) => {
                    const r = await server.command({ type: 'clip_outro_delete', id: p.id });
                    setOutroMsg(r.ok ? null : (r.error ?? 'ลบคำท้ายไม่ได้'));
                  }}
                />
                {outroMsg && (
                  <div className="cl-err" role="alert">
                    {outroMsg}
                  </div>
                )}
              </div>
              <div className="cl-sub" aria-label="สไตล์">
            <div className="cl-row">
              <h2>สไตล์</h2>
              <div className="cl-chips" style={{ flex: '0 0 auto' }}>
                <button type="button" className="cl-chip" aria-pressed={src === 'ours'} onClick={() => setSrc('ours')}>
                  สไตล์เดิมของเรา
                </button>
                <button type="button" className="cl-chip" aria-pressed={src === 'lemo'} onClick={() => setSrc('lemo')}>
                  Lemo-Opuscar{cfg?.lemo.installed ? ` · ${cfg.lemo.styles.length}` : ''}
                </button>
              </div>
            </div>
            {src === 'ours' && (
              <div className="cl-grid">
                {cfg?.ours.map((o) => (
                  <button key={o.id} type="button" className="cl-style" aria-pressed={style === `ours:${o.id}`} onClick={() => setStyle(`ours:${o.id}`)}>
                    {stills[o.id] === false ? (
                      <span className="cl-ph">[ยังไม่มีไฟล์ render — ภาพจะมาหลัง render แรก]</span>
                    ) : (
                      <img src={`${API}${o.stillUrl}`} alt={o.alt} loading="lazy" onError={() => setStills((s) => ({ ...s, [o.id]: false }))} />
                    )}
                    <span className="cl-style-text">
                      <b>{o.name}</b>
                      <span>{o.note}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {src === 'lemo' && cfg && !cfg.lemo.installed && (
              <div className="cl-row">
                <span className="cl-note" role="status">
                  ยังไม่ได้ติดตั้ง Lemo-Opuscar{cfg.lemo.error ? ` (${cfg.lemo.error})` : ''}
                </span>
                <button type="button" className="cc-btn" onClick={() => void reload()}>
                  โหลดรายการสไตล์ใหม่
                </button>
              </div>
            )}
            {src === 'lemo' && cfg?.lemo.installed && (
              <>
                <div className="cl-chips">
                  {cfg.lemo.categories.map((c) => (
                    <button key={c} type="button" className="cl-chip" style={{ fontSize: 13, padding: '0 12px' }} aria-pressed={cat === c} onClick={() => setCat(c)}>
                      {c}
                    </button>
                  ))}
                  <button type="button" className="cc-btn" onClick={() => void reload()}>
                    โหลดรายการสไตล์ใหม่
                  </button>
                </div>
                <div className="cl-grid">
                  {lemoStyles.map((s) => (
                    <button key={s.id} type="button" className="cl-style" aria-pressed={style === `lemo:${s.id}`} onClick={() => setStyle(`lemo:${s.id}`)}>
                      {s.thumbUrl ? (
                        <img src={s.thumbUrl.startsWith('/') ? `${API}${s.thumbUrl}` : s.thumbUrl} alt={`ภาพนิ่งสไตล์ ${s.name}`} loading="lazy" />
                      ) : (
                        <span className="cl-ph">[ไม่มีภาพนิ่ง]</span>
                      )}
                      <span className="cl-style-text">
                        <b>{s.name}</b>
                        <span>ออกแบบมาให้ Claude สร้าง</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
            </div>
          </section>

          <details className="cl-card cl-adv">
            <summary>
              โมเดล · เสียงพากย์ · โหมด{' '}
              <span className="cc-muted">
                ({scriptModel} → {builderModel} · {voiceOn ? (voiceName ?? 'เลือกเสียง') : 'ไม่มีเสียงพากย์'})
              </span>
            </summary>
            <section className="cl-card" aria-label="โมเดล">
            <h2>โมเดล</h2>
            <div className="cl-row" style={{ justifyContent: 'flex-start', alignItems: 'flex-end' }}>
              <div className="cl-field">
                <label htmlFor="m1">เขียนบท + storyboard</label>
                <select id="m1" className="cc-sel" value={scriptModel} onChange={(e) => setScriptModel(e.target.value)}>
                  {scriptOpts.map((o) => (
                    <option key={o.id} value={o.id} disabled={!!o.disabled} title={o.disabled}>
                      {o.disabled ? `${o.label} (${o.disabled})` : `Claude · ${o.label}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="cl-field">
                <label htmlFor="m2">สร้าง scene (เขียนโค้ด)</label>
                <select id="m2" className="cc-sel" value={builderModel} onChange={(e) => setBuilderModel(e.target.value)}>
                  {builderOpts.map((o) => (
                    <option key={o.id} value={o.id}>
                      Claude · {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="cl-field" style={{ flex: '1 1 240px' }}>
                <label htmlFor="m5">โหมด</label>
                <PermissionModeField
                  id="m5"
                  large
                  value={permMode}
                  onCommit={(m, confirmed) => {
                    setPermMode(m);
                    setBypassOk(confirmed);
                  }}
                />
              </div>
              <div className="cl-field" style={{ flex: '0 0 auto', minWidth: 0 }}>
                <label htmlFor="m6">Remote</label>
                <RemoteToggle id="m6" on={rc} onChange={setRc} />
              </div>
              <div className="cl-field" style={{ flex: '0 1 140px' }}>
                <label htmlFor="m4">Effort</label>
                <select id="m4" className="cc-sel" value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
                  {EFFORT_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {style.startsWith('lemo:') && <p className="cl-note">ออกแบบมาให้ Claude สร้าง — โมเดลอื่นอาจทำสไตล์ไม่เหมือน</p>}
          </section>
            <section className="cl-card" aria-label="เสียงพากย์">
            <div className="cl-row">
              <h2>เสียงพากย์</h2>
              <span className="cc-mono cc-muted">ElevenLabs · {cfg?.voiceModel ?? 'eleven_v3'} (หลัก)</span>
            </div>
            {cfg?.voices.map((v) => (
              <div key={v.id} className="cl-voice" data-on={voice === v.id}>
                <button type="button" className="cl-voice-pick" aria-pressed={voice === v.id} onClick={() => setVoice(v.id)}>
                  <b>{v.name}</b>
                  <span>{v.id}</span>
                </button>
                {!v.builtin && (
                  <button type="button" className="cc-btn" onClick={() => void removeVoice(v.id)}>
                    ลบ
                  </button>
                )}
                <button type="button" className={`cc-btn cl-play${playing === v.id ? ' is-busy' : ''}`} disabled={!!playing} onClick={() => void play(v)}>
                  {playing === v.id ? 'กำลังสร้าง…' : 'ลองฟัง'}
                </button>
              </div>
            ))}
            <div className="cl-row" style={{ justifyContent: 'flex-start', alignItems: 'flex-end' }}>
              <div className="cl-field">
                <label htmlFor="vid">เพิ่ม voice ID ของ ElevenLabs</label>
                <input id="vid" className="cc-input cc-mono" value={newVoice} placeholder="วาง voice ID" onChange={(e) => setNewVoice(e.target.value)} />
              </div>
              <div className="cl-field">
                <label htmlFor="vname">ชื่อเรียก (ไม่บังคับ)</label>
                <input id="vname" className="cc-input" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} />
              </div>
              <button type="button" className="cc-btn" style={{ minHeight: 44 }} disabled={newVoice.trim() === ''} onClick={() => void addVoice()}>
                เพิ่ม
              </button>
            </div>
            <div className="cl-field">
              <label htmlFor="vtext">ประโยคทดลองฟัง ({[...sample].length}/120)</label>
              <input id="vtext" className="cc-input" value={sample} maxLength={120} onChange={(e) => setSample(e.target.value)} />
            </div>
            {audioUrl && <audio ref={audio} id="voice-audio" controls src={audioUrl} style={{ width: '100%' }} />}
            {voiceMsg && (
              <p className="cl-note" role="status">
                {voiceMsg}
              </p>
            )}
            <p className="cl-note">key ElevenLabs เป็นแบบ TTS อย่างเดียว (ดึงรายชื่อเสียงไม่ได้) จึงใส่ voice ID เอง · ลองฟังครั้งแรกใช้เครดิต ครั้งต่อไปประโยคเดิมใช้ cache</p>
          </section>
          </details>
        </main>

        <aside className="cl-side cl-right" aria-label="คิวงานคลิป">
          <QueuePanel jobs={server.clips} waiting={server.clipQueue} presets={presets} runners={server.runners} onRender={render} onRenderAll={renderAll} onRemove={removeQueued} />
          {renderMsg && (
            <div className="cl-err" role="alert">
              {renderMsg}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
