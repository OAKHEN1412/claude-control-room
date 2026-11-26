// Full-screen gate: shown while the terminal claude (the main account) is not logged in.
// It disappears by itself: the accounts broadcast flips main.loggedIn and gateVisible() turns false.
import type { AccountInfo, MainLoginEvent } from '../../../shared/accounts';
import { useT } from '../i18n';
import { gateVisible } from '../mainLoginLogic';
import { MainLoginPanel } from './MainLoginPanel';
import './mainLogin.css';

export function MainLoginGate(props: {
  accounts: AccountInfo[];
  mainLogin: MainLoginEvent | null;
  ptyAvailable: boolean;
  onRecheck?(): void;
}): JSX.Element | null {
  const t = useT(); // hook first, so the early return below keeps the hook order stable
  if (!gateVisible(props.accounts)) return null;
  return (
    <div className="ml-gate" role="dialog" aria-modal="true" aria-labelledby="ml-gate-title">
      <div className="ml-card">
        <h2 id="ml-gate-title" className="ml-title">{t('acct.main.title')}</h2>
        <p className="ml-text">{t('acct.main.explain')}</p>
        <MainLoginPanel mainLogin={props.mainLogin} ptyAvailable={props.ptyAvailable} onSuccess={props.onRecheck} />
      </div>
    </div>
  );
}
