// English text. Each part is type-checked against its Thai part, so a missing key fails tsc.
import { shellEn } from './parts/shell.en';
import { clipEn } from './parts/clip.en';
import { canvasEn } from './parts/canvas.en';
import { machineEn } from './parts/machine.en';
import { panelsEn } from './parts/panels.en';
import { serverEn } from './parts/server.en';
import { setupEn } from './parts/setup.en';
import { acctBaseEn } from './parts/acctBase.en';
import { acctPopoverEn } from './parts/acctPopover.en';
import { acctDialogEn } from './parts/acctDialog.en';
import { acctManageEn } from './parts/acctManage.en';
import { acctJobEn } from './parts/acctJob.en';
import { acctNewEn } from './parts/acctNew.en';
import { acctMainEn } from './parts/acctMain.en';
import { acctLockEn } from './parts/acctLock.en';
import { acctAppLockEn } from './parts/acctAppLock.en';
export const en: Record<string, string> = {
  ...shellEn,
  ...clipEn,
  ...canvasEn,
  ...machineEn,
  ...panelsEn,
  ...serverEn,
  ...setupEn,
  ...acctBaseEn,
  ...acctPopoverEn,
  ...acctDialogEn,
  ...acctManageEn,
  ...acctJobEn,
  ...acctNewEn,
  ...acctMainEn,
  ...acctLockEn,
  ...acctAppLockEn,
};
