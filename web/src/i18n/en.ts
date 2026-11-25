// English text. Each part is type-checked against its Thai part, so a missing key fails tsc.
import { shellEn } from './parts/shell.en';
import { clipEn } from './parts/clip.en';
import { canvasEn } from './parts/canvas.en';
import { machineEn } from './parts/machine.en';
import { panelsEn } from './parts/panels.en';
import { serverEn } from './parts/server.en';
import { setupEn } from './parts/setup.en';
export const en: Record<string, string> = {
  ...shellEn,
  ...clipEn,
  ...canvasEn,
  ...machineEn,
  ...panelsEn,
  ...serverEn,
  ...setupEn,
};
