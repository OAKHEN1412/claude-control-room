import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RunnerState, SessionInfo, Status } from '../../../shared/protocol';
import { modeBadges } from '../control';
import { agentLine } from '../machineForm';
import type { MachineInfo } from '../protocolNext';
import type { CharView } from '../useCharacter';
import { Character } from './Character';
import {
  layoutGraph,
  badgeText,
  STATUS_WORD,
  STATUS_VAR,
  type Box,
} from './graphLayout';
import { limitText } from '../limit';
import './graph.css';

export interface GraphProps {
  machine: string;
  machines?: MachineInfo[]; // other PCs: a group per machine that has sessions (v1 groups remote sessions under their machine)
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  selectedAgentId: string | null;
  onSelect: (sessionId: string, agentId: string | null) => void;
  runners?: Record<string, RunnerState>; // permission mode / RC badges
  char: CharView; // stage 6: what the character shows (state + label)
  onCharClick: () => void; // opens the question popup; only used while something waits
}

const boxStyle = (b: Box): CSSProperties => ({ left: b.x, top: b.y, width: b.w, height: b.h });

interface NodeButtonProps {
  kind: 'session' | 'subagent';
  box: Box;
  status: Status;
  name: string;
  sub?: string;
  badge: string;
  extras?: string[]; // permission mode (when not default) and RC
  thought: string;
  limit?: string | null; // red label while the session is at a usage limit
  label: string;
  pressed: boolean;
  onClick: () => void;
}

function NodeButton(p: NodeButtonProps) {
  const color = STATUS_VAR[p.status];
  const live = p.status === 'running' || p.status === 'waiting';
  return (
    <button
      type="button"
      className={`cg-node cg-${p.kind}`}
      data-status={p.status}
      data-limit={p.limit ? '1' : undefined}
      aria-pressed={p.pressed}
      aria-label={p.label}
      title={`${STATUS_WORD[p.status]}: ${p.name}${p.sub ? ` (${p.sub})` : ''}`}
      style={boxStyle(p.box)}
      onClick={p.onClick}
    >
      <span className="cg-row">
        <span
          aria-hidden="true"
          className={`cg-dot${live ? ' cg-live-dot' : ''}`}
          style={{ background: color }}
        />
        <span className="cg-name">
          {p.name}
          {p.sub && <span className="cg-sub-inline"> {p.sub}</span>}
        </span>
        <span className="cg-badge">{p.badge}</span>
      </span>
      <span className="cg-thought">
        {p.extras?.map((x) => (
          <span key={x} className={`cg-tag${x === 'RC' ? ' is-rc' : ''}${x === 'bypassPermissions' ? ' is-risk' : ''}`}>
            {x}
          </span>
        ))}
        {p.limit ? <span className="cg-limit">{p.limit}</span> : p.thought || STATUS_WORD[p.status]}
      </span>
    </button>
  );
}

export function Graph({ machine, machines, sessions, runners, selectedSessionId, selectedAgentId, onSelect, char, onCharClick }: GraphProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 400 });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth || 1000, h: el.clientHeight || 400 });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-check the "finished within 10 minutes" rule even when no new data arrives.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // This PC first, then one group per other machine that has sessions (its own machine node over its sessions).
  const groups = useMemo(() => {
    const local = sessions.filter((s) => s.machineId === undefined);
    const out: Array<{ key: string; name: string; machineId: string | null; layout: ReturnType<typeof layoutGraph> }> = [
      { key: '', name: machine, machineId: null, layout: layoutGraph(local, { width: size.w, minHeight: sessions.length === local.length ? size.h : 0, now, expanded }) },
    ];
    const ids = [...new Set(sessions.filter((s) => s.machineId !== undefined).map((s) => s.machineId as string))];
    for (const id of ids) {
      const list = sessions.filter((s) => s.machineId === id);
      out.push({ key: id, name: machines?.find((m) => m.id === id)?.name ?? id, machineId: id, layout: layoutGraph(list, { width: size.w, minHeight: 0, now, expanded }) });
    }
    return out;
  }, [sessions, machine, machines, size.w, size.h, now, expanded]);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);

  const toggle = (sid: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });

  const asking = char.state === 'asking';

  return (
    <div className="cg-wrap" ref={wrapRef}>
      {groups.map((g) => {
      const layout = g.layout;
      const remoteInfo = g.machineId ? machines?.find((m) => m.id === g.machineId) : undefined;
      return (
      <div
        key={g.key}
        className="cg-stage"
        role="region"
        aria-label={g.machineId ? `โครงข่ายงานของเครื่อง ${g.name}` : 'โครงข่ายงาน'}
        data-machine={g.machineId ?? undefined}
        style={{ width: layout.width, height: layout.height }}
      >
        <svg
          className="cg-edges"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
          focusable="false"
        >
          {layout.edges.map((e) => {
            const waitingEdge = e.kind === 'session' && byId.get(e.sessionId)?.status === 'waiting';
            return (
              <path
                key={e.key}
                d={e.path}
                className={waitingEdge ? 'cg-edge cg-edge-waiting' : 'cg-edge'}
                style={{ stroke: waitingEdge ? 'var(--waiting)' : 'var(--line-2)' }}
              />
            );
          })}
        </svg>

        <div className="cg-machine" style={boxStyle(layout.machine)} data-remote={g.machineId ? '1' : undefined}>
          {g.machineId ? (
            <>
              <div className="cg-machine-name" title={g.name}>
                {g.name}
              </div>
              <div className="cg-mood" role="status">
                {remoteInfo ? agentLine(remoteInfo) : ''}
              </div>
            </>
          ) : asking ? (
            <button type="button" className="cg-char-btn" onClick={onCharClick} aria-label={`${char.label} — กดเพื่อเปิดคำถาม`} title="กดเพื่อเปิดคำถามที่รออยู่">
              <Character state={char.state} />
            </button>
          ) : (
            <Character state={char.state} />
          )}
          <div className="cg-machine-name" title={machine}>
            {machine}
          </div>
          <div className="cg-mood" style={{ color: asking ? 'var(--waiting)' : char.state === 'error' ? 'var(--error)' : 'var(--text)' }} role="status">
            {char.label}
          </div>
        </div>

        {layout.empty && <div className="cg-empty">ไม่พบ session ที่เปิดอยู่</div>}

        {layout.nodes.map((n) => {
          if (n.kind === 'collapsed') {
            return (
              <button
                key={n.key}
                type="button"
                className="cg-node cg-more"
                style={boxStyle(n)}
                aria-expanded={n.expanded}
                onClick={() => toggle(n.sessionId)}
              >
                {n.expanded ? 'ซ่อนตัวที่เสร็จแล้ว' : `เสร็จแล้ว ${n.count} ตัว · กดเพื่อดู`}
              </button>
            );
          }
          const s = byId.get(n.sessionId);
          if (!s) return null;
          if (n.kind === 'session') {
            return (
              <NodeButton
                key={n.key}
                kind="session"
                box={n}
                status={s.status}
                name={s.title && s.title !== '(ไม่มีชื่อ)' ? s.title : s.name}
                sub={s.title && s.title !== '(ไม่มีชื่อ)' ? s.name : undefined}
                badge={badgeText(s.model, s.effort)}
                extras={modeBadges(runners?.[s.sessionId])}
                thought={s.thought}
                limit={limitText(s, runners?.[s.sessionId])}
                label={`งาน ${s.title || s.name} ${STATUS_WORD[s.status]}`}
                pressed={s.sessionId === selectedSessionId}
                onClick={() => onSelect(s.sessionId, null)}
              />
            );
          }
          const a = s.subagents.find((x) => x.id === n.agentId);
          if (!a) return null;
          return (
            <NodeButton
              key={n.key}
              kind="subagent"
              box={n}
              status={a.status}
              name={a.description}
              badge={badgeText(a.model, a.effort)}
              thought={a.thought}
              label={`งานย่อย ${a.description} ${STATUS_WORD[a.status]}`}
              pressed={s.sessionId === selectedSessionId && a.id === selectedAgentId}
              onClick={() => onSelect(s.sessionId, a.id)}
            />
          );
        })}
      </div>
      );
      })}
    </div>
  );
}
