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
