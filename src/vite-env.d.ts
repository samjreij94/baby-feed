/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sync server base URL, e.g. https://baby-feed-sync.<acct>.workers.dev (no trailing slash). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
