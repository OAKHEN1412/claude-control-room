import { useState } from 'react';
import type { TimelineEvent } from '../../../shared/protocol';
import { formatTimeline, thoughtLine, type TermLine } from '../terminalLines';
import { useT, type TKey } from '../i18n';
import './terminal.css';

export interface TerminalLogProps {
  events: ReadonlyArray<TimelineEvent>;
  /** Latest thought, shown as a dim ✻ line at the end. */
  thought?: string;
  emptyText?: string;
}

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const KIND_KEY: Record<TermLine['kind'], TKey> = {
  user: 'panels.termLog.user',
  assistant: 'panels.termLog.assistant',
  tool: 'panels.termLog.tool',
  error: 'panels.termLog.error',
  thought: 'panels.termLog.thought',
};

function Line({ line, open, onToggle }: { line: TermLine; open: boolean; onToggle: () => void }) {
  const t = useT();
  const text = open ? line.full : line.text;
  return (
    <li className={`tl-line tl-${line.kind}${line.nested ? ' is-nested' : ''}${line.tone === 'limit' ? ' tl-limit' : ''}`}>
      <span className="tl-mark" aria-hidden="true">
        {line.mark}
      </span>
      <span className="cr-sr">{line.tone === 'limit' ? t('panels.termLog.limit') : t(KIND_KEY[line.kind])}: </span>
      {line.collapsible ? (
        <button type="button" className="tl-text tl-expand" aria-expanded={open} title={open ? t('panels.termLog.collapse') : t('panels.termLog.expand')} onClick={onToggle}>
          {text}
        </button>
      ) : (
        <span className="tl-text">{text}</span>
      )}
      {line.ts !== null && (
        <time className="tl-time" dateTime={new Date(line.ts).toISOString()}>
          {hhmmss(line.ts)}
        </time>
      )}
    </li>
  );
}

/** The session timeline drawn like the Claude Code terminal. Presentation only; scrolling stays with the parent. */
export function TerminalLog({ events, thought = '', emptyText }: TerminalLogProps) {
  const t = useT();
  const empty = emptyText ?? t('panels.termLog.empty');
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const lines = formatTimeline(events);
  const think = thoughtLine(thought);
  const toggle = (key: string) =>
    setOpenKeys((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (lines.length === 0 && !think) return <div className="tl-empty">{empty}</div>;
  return (
    <ol className="tl-log">
      {lines.map((l) => (
        <Line key={l.key} line={l} open={openKeys.has(l.key)} onToggle={() => toggle(l.key)} />
      ))}
      {think && <Line key={think.key} line={think} open={false} onToggle={() => {}} />}
    </ol>
  );
}
