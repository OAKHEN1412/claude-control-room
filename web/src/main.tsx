import { StrictMode, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './styles.css';
import './scrollbar.css';
import { App } from './App';
import { ClipPage } from './components/ClipPage';
import './components/clip.css';
import { GalleryPage } from './components/GalleryPage';
import { AccountsPage } from './components/AccountsPage';
import './components/accountsPage.css';
import { AppLockPage } from './components/AppLockPage';
import { getAuthState, type AuthState } from './authClient';
import { authGateView } from './unlockLogic';

/**
 * App lock gate: asks the server whether a password is set and whether this browser is unlocked.
 * While it is locked every route shows the lock page. A failed request (older server, 404) counts as not required.
 */
function AuthGate(props: { children: ReactNode }) {
  // undefined = still loading; null = the request failed (treated as open).
  const [state, setState] = useState<AuthState | null | undefined>(undefined);

  const reload = useCallback(() => {
    void getAuthState().then((r) => setState(r.ok ? { required: r.required, unlocked: r.unlocked } : null));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const view = authGateView(state);
  if (view === 'loading') return null;
  if (view === 'locked') return <AppLockPage onUnlocked={reload} />;
  return <>{props.children}</>;
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

const path = window.location.pathname.replace(/\/+$/, '');
createRoot(root).render(
  <StrictMode>
    <AuthGate>
      {path === '/clip' ? <ClipPage /> : path === '/gallery' ? <GalleryPage /> : path === '/accounts' ? <AccountsPage /> : <App />}
    </AuthGate>
  </StrictMode>,
);
