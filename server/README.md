# baby-feed sync server

Cloudflare Worker + **one Durable Object per household** (SQLite storage). Contract: [`../SPEC.md`](../SPEC.md) §4–6.

| File | What |
| --- | --- |
| `src/logic.ts` | Pure: validation, LWW, cursor paging, `Household` over a `HouseholdStorage` (memory or SQLite) |
| `src/app.ts` | Pure Fetch-API router (CORS, rate limits, auth) + `createMemoryServer()` for tests |
| `src/index.ts` | Worker entry + `HouseholdDO` (SQLite tables `meta`, `entries`) |
| `scripts/smoke.ts` | Two simulated phones (the real client core) against a running server |

Routes: `POST /api/households` → `{householdId, secret}` · `POST /api/households/join` (Bearer secret) →
`{householdId, members}` · `POST /api/sync` (Bearer secret) · `GET /health`.
Only SHA-256(secret) is stored; `householdId` = first 32 hex chars of it = the DO name (`idFromName`).

## Local dev

```sh
export PATH=~/.local/node-v22.23.3-linux-x64/bin:$PATH   # Node 22
cd server
npm ci
npm test              # unit tests (vitest)
npm run typecheck
npx wrangler dev --local --port 8787     # or: npm run dev
# in another shell, with the server running:
npm run smoke         # SYNC_URL=http://localhost:8787 by default
```

`ALLOWED_ORIGINS` (wrangler.jsonc) allows `https://samjreij94.github.io` and localhost/127.0.0.1 on 5173 (vite dev)
and 4173 (vite preview). Requests without an Origin header (curl, scripts) are allowed.

## Deploy (needs a Cloudflare account)

1. Auth, either:
   - `npx wrangler login` (browser OAuth), or
   - `export CLOUDFLARE_API_TOKEN=…` (token with *Workers Scripts: Edit*; also `CLOUDFLARE_ACCOUNT_ID=…` if the
     token can see several accounts).
2. `cd server && npm ci && npx wrangler deploy` — creates the `baby-feed-sync` Worker and applies the `v1`
   migration (`new_sqlite_classes: [HouseholdDO]`). Note the URL it prints:
   `https://baby-feed-sync.<subdomain>.workers.dev`.
3. Check: `curl https://baby-feed-sync.<subdomain>.workers.dev/health` → `ok`; optionally
   `SYNC_URL=https://baby-feed-sync.<subdomain>.workers.dev ORIGIN=https://samjreij94.github.io npm run smoke`
   (creates one throwaway household).
4. Build + publish the app pointing at it (repo root):
   ```sh
   VITE_API_BASE_URL=https://baby-feed-sync.<subdomain>.workers.dev npm run deploy
   ```
   (`npm run deploy` = build + `gh-pages -d dist`, base `/baby-feed/`.)

Changing the DO class or storage later needs a new migration tag in `wrangler.jsonc`; never edit `v1`.
