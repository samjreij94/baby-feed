import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// Production entry: <App /> on Dealer's real core (hooks default to getCore(), which reads VITE_API_BASE_URL).
// Dev only: `?demo` (or ?demo=reset|fresh|remote, &phone=2) boots an in-browser demo sync server with seeded feeds.
// The import.meta.env.DEV guard is statically false in `vite build`, so the demo harness never reaches dist/.
const root = createRoot(document.getElementById('root')!);
const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>);

if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
  void Promise.all([import('./ui/demo'), import('./ui/adapter')]).then(async ([demo, { CoreScope }]) => {
    const core = await demo.bootDemoCore();
    render(<CoreScope core={core}><App /></CoreScope>);
  });
} else {
  render(<App />);
}

// Pick up new releases promptly: check for a new service worker on launch, whenever the app comes back to the
// foreground, and every 30 min. The worker uses skipWaiting + clientsClaim, so the new one takes over at once;
// reload then so the open page runs the new bundle (an installed iOS app otherwise keeps the old JS in memory).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  const check = () => { void navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => undefined); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.setInterval(check, 30 * 60_000);
  check();
}
