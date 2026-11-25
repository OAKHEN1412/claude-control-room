// Thai text = source of truth. Parts are merged here; each area owns web/src/i18n/parts/<area>.th.ts
import { shellTh } from './parts/shell.th';
import { clipTh } from './parts/clip.th';
import { canvasTh } from './parts/canvas.th';
import { machineTh } from './parts/machine.th';
import { panelsTh } from './parts/panels.th';
import { serverTh } from './parts/server.th';
import { setupTh } from './parts/setup.th';
export const th = {
  ...shellTh,
  ...clipTh,
  ...canvasTh,
  ...machineTh,
  ...panelsTh,
  ...serverTh,
  ...setupTh,
} as const satisfies Record<string, string>;
