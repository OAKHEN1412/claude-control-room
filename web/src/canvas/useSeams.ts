// Reads ?seams= from the URL and, while seams exist, tells the stylesheet which monitor is active (the one holding the
// mouse or the focused element) through --cr-mon-l / --cr-mon-r, so centred popups (question popup) stay on one monitor.
import { useEffect, useState } from 'react';
import { monitorAt, monitorSpans, parseSeams } from './seams';

export interface SeamState {
  seams: number[];
  width: number;
}

const NONE: number[] = [];

function read(prev?: SeamState): SeamState {
  if (typeof window === 'undefined') return { seams: NONE, width: 0 };
  const width = window.innerWidth;
  // The launcher counts seams from the window's outer left edge; the client area starts after the (invisible) frame.
  const frame = Math.round((window.outerWidth - width) / 2);
  const shift = frame > 0 && frame <= 24 ? frame : 0;
  const found = parseSeams(window.location.search, window.outerWidth > width ? window.outerWidth : width)
    .map((x) => x - shift)
    .filter((x) => x > 0 && x < width);
  const seams = prev && prev.seams.join() === found.join() ? prev.seams : found.length ? found : NONE;
  return prev && prev.width === width && prev.seams === seams ? prev : { seams, width };
}

export function useSeams(): SeamState {
  const [state, setState] = useState<SeamState>(() => read());
  useEffect(() => {
    const onResize = () => setState((cur) => read(cur));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const key = state.seams.join();
  useEffect(() => {
    if (state.seams.length === 0) return;
    const root = document.documentElement;
    const spans = monitorSpans(state.seams, state.width);
    let cur = -1;
    const set = (i: number) => {
      if (i === cur) return;
      cur = i;
      root.style.setProperty('--cr-mon-l', `${spans[i].x}px`);
      root.style.setProperty('--cr-mon-r', `${Math.max(0, state.width - spans[i].x - spans[i].w)}px`);
    };
    root.style.setProperty('--cr-last-l', `${spans[spans.length - 1].x}px`);
    set(spans.length - 1);
    const onMove = (e: PointerEvent) => set(monitorAt(spans, e.clientX));
    const onFocus = (e: FocusEvent) => {
      const r = (e.target as Element | null)?.getBoundingClientRect?.();
      if (r && r.width > 0) set(monitorAt(spans, r.left + r.width / 2));
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('focusin', onFocus);
      root.style.removeProperty('--cr-last-l');
      root.style.removeProperty('--cr-mon-l');
      root.style.removeProperty('--cr-mon-r');
    };
  }, [key, state.width]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
