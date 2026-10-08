# Baby Feed

Feeding tracker PWA (breast + bottle) for iPhone, synced between two phones. Vite + React + TypeScript.

## Layout / ownership

| Path | Owner |
| --- | --- |
| `src/core/` | Logic layer: types, IndexedDB store, sync client, metrics, hooks. No UI. |
| `server/` | Cloudflare Worker + Durable Object sync server |
| `src/ui/`, `src/screens/`, `src/components/`, `public/`, service worker | UI (Graphics) |

The data + sync contract is in [`SPEC.md`](./SPEC.md). The UI imports only from `src/core`.

## Scripts

```sh
npm run dev        # vite dev server
npm run build      # tsc -b && vite build
npm run typecheck  # tsc -b
npm test           # vitest run (jsdom + fake-indexeddb)
npm run lint       # oxlint
npm run deploy     # build + gh-pages -d dist  (base: /baby-feed/)
```

`VITE_API_BASE_URL` sets the sync server (default `http://localhost:8787` in dev).
