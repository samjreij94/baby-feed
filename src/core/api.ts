/** HTTP client for the sync server (SPEC §4–5). fetch is injectable for tests. */
import type { CreateHouseholdResponse, JoinHouseholdResponse, SyncRequest, SyncResponse } from './types';

/** fetch failed (offline, DNS, CORS, timeout). */
export class NetworkError extends Error {
  constructor(message = 'Network unreachable') {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Server answered with a non-2xx status. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClient {
  createHousehold(): Promise<CreateHouseholdResponse>;
  joinHousehold(secret: string): Promise<JoinHouseholdResponse>;
  sync(secret: string, req: SyncRequest): Promise<SyncResponse>;
}

export function createApiClient(baseUrl: string, fetchImpl?: FetchLike, timeoutMs = 15_000): ApiClient {
  const base = baseUrl.replace(/\/+$/, '');
  async function call<T>(path: string, body: unknown, secret?: string): Promise<T> {
    const f: FetchLike = fetchImpl ?? ((i, init) => fetch(i, init));
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let res: Response;
    try {
      res = await f(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify(body),
        signal: ctrl?.signal,
      });
    } catch (e) {
      throw new NetworkError(e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok) throw new HttpError(res.status, (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
    return data as T;
  }
  return {
    createHousehold: () => call('/api/households', {}),
    joinHousehold: (secret) => call('/api/households/join', {}, secret),
    sync: (secret, req) => call('/api/sync', req, secret),
  };
}
