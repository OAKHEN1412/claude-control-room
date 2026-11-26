// Thai text = source of truth. Parts are merged here; each area owns web/src/i18n/parts/<area>.th.ts
import { shellTh } from './parts/shell.th';
import { clipTh } from './parts/clip.th';
import { canvasTh } from './parts/canvas.th';
import { machineTh } from './parts/machine.th';
import { panelsTh } from './parts/panels.th';
import { serverTh } from './parts/server.th';
import { setupTh } from './parts/setup.th';
import { acctBaseTh } from './parts/acctBase.th';
import { acctPopoverTh } from './parts/acctPopover.th';
import { acctDialogTh } from './parts/acctDialog.th';
import { acctManageTh } from './parts/acctManage.th';
import { acctJobTh } from './parts/acctJob.th';
import { acctNewTh } from './parts/acctNew.th';
import { acctMainTh } from './parts/acctMain.th';
import { acctLockTh } from './parts/acctLock.th';
import { acctAppLockTh } from './parts/acctAppLock.th';
export const th = {
  ...shellTh,
  ...clipTh,
  ...canvasTh,
  ...machineTh,
  ...panelsTh,
  ...serverTh,
  ...setupTh,
  ...acctBaseTh,
  ...acctPopoverTh,
  ...acctDialogTh,
  ...acctManageTh,
  ...acctJobTh,
  ...acctNewTh,
  ...acctMainTh,
  ...acctLockTh,
  ...acctAppLockTh,
} as const satisfies Record<string, string>;
