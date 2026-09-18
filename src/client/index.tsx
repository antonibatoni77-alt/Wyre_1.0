import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { toast, Toaster } from 'react-hot-toast';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { Router } from './router';
import favicon from './assets/favicon.svg';
import './index.css';
import LoadingSpinner from './components/LoadingSpinner';
import { Seo } from './components/Seo';
import { TooltipProvider } from './components/ui/Tooltip';
import { connectWyreClient } from './lib/api';
import { registerServiceWorker } from './wyre/utils/push';
import { initDesktopNotifications, initOfflinePersistence, isNetworkFailure } from './wyre/utils/desktop';

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // Offline states must not look like application errors: the interface
    // keeps showing the last known data and reconnects silently.
    onError: (error) => {
      if (!isNetworkFailure(error)) toast.error(error.message);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (!isNetworkFailure(error)) toast.error(error.message);
    },
  }),
});
connectWyreClient(queryClient);
initOfflinePersistence(queryClient);
initDesktopNotifications(queryClient);
void registerServiceWorker();

function App() {
  return (
    <TooltipProvider delay={150}>
      <Suspense fallback={<LoadingSpinner fullScreen />}>
        {/* Site-wide SEO defaults; pages can override via <Page seo={{...}}> */}
        <Seo />
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              background: 'rgba(20, 22, 32, 0.9)',
              color: '#f7f8fc',
              border: '1px solid rgba(255,255,255,0.08)',
              backdropFilter: 'blur(18px)',
              fontSize: '13px',
            },
          }}
        />
        <Router />
      </Suspense>
    </TooltipProvider>
  );
}

const faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link');
faviconLink.rel = 'icon';
faviconLink.href = favicon;
if (!faviconLink.parentNode) document.head.appendChild(faviconLink);

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
