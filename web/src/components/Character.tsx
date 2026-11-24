import './graph.css';
import type { CharState } from '../character';

export type { CharState };

// Claude character from the mockup. Motion is CSS-only (graph.css) and is switched off under
// prefers-reduced-motion. Decorative, so aria-hidden; the label next to it carries the meaning.
export function Character({ state }: { state: CharState }) {
  return (
    <svg className="cg-char" data-state={state} viewBox="0 0 96 76" aria-hidden="true" focusable="false">
      <g className="cg-body">
        <rect className="cg-skin cg-arm" x="4" y="30" width="16" height="10" rx="3" />
        <rect className="cg-skin cg-arm-r" x="76" y="30" width="16" height="10" rx="3" />
        <rect className="cg-skin cg-head" x="16" y="8" width="64" height="48" rx="8" />
        <rect className="cg-eye" x="32" y="24" width="7" height="12" rx="2" />
        <rect className="cg-eye" x="57" y="24" width="7" height="12" rx="2" />
        <rect className="cg-skin" x="24" y="56" width="8" height="14" rx="2" />
        <rect className="cg-skin" x="38" y="56" width="8" height="14" rx="2" />
        <rect className="cg-skin" x="52" y="56" width="8" height="14" rx="2" />
        <rect className="cg-skin" x="66" y="56" width="8" height="14" rx="2" />
      </g>
      {state === 'done' && <circle className="cg-mark cg-mark-done" cx="88" cy="8" r="7" />}
      {state === 'error' && <circle className="cg-mark cg-mark-error" cx="88" cy="8" r="7" />}
      {state === 'asking' && (
        <g className="cg-mark cg-bubble">
          <rect className="cg-bubble-bg" x="72" y="-12" width="22" height="22" rx="6" />
          <path className="cg-bubble-tail" d="M76 10 L74 17 L84 10 Z" />
          <text className="cg-mark-ask" x="83" y="4" textAnchor="middle">
            !
          </text>
        </g>
      )}
    </svg>
  );
}
