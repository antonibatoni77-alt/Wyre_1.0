import { lazy, useEffect } from 'react';

const WyrePage = lazy(() => import('./pages/WyrePage'));
const MagicLinkPage = lazy(() => import('./pages/MagicLinkPage'));

/** Wyre only has the messenger and the emailed magic-link landing page. */
export function Router() {
  const isMagicLink = window.location.pathname === '/auth/magic-link';
  const isKnownPath = window.location.pathname === '/' || isMagicLink;

  useEffect(() => {
    if (!isKnownPath) window.history.replaceState(null, '', '/');
  }, [isKnownPath]);

  return isMagicLink ? <MagicLinkPage /> : <WyrePage />;
}
