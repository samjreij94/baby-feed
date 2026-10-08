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

`VITE_API_BASE_URL` sets the sync server (default `http://localhost:8787`).

## Run everything locally (two "phones" = two browser profiles)

```sh
export PATH=~/.local/node-v22.23.3-linux-x64/bin:$PATH
(cd server && npm ci && npx wrangler dev --local --port 8787)   # terminal 1: sync server
npm ci && npm run dev -- --host 127.0.0.1 --port 5173          # terminal 2: app
```

Open `http://localhost:5173/baby-feed/` in profile 1 (create household), and the invite link (or code) in a
second profile / incognito window (join). Each profile has its own IndexedDB = its own device.
Server details and deploy: [`server/README.md`](server/README.md).
