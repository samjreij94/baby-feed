/** Pure HTTP helpers (CORS, Origin allow-list, rate limit) — no Workers-only imports. Patterned on poker-coach/server. */
export interface HttpEnv {
  ALLOWED_ORIGINS?: string;
}

function allowedOrigins(env: HttpEnv): string[] {
  return (env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** No Origin header (curl, Node) is allowed; browser origins must be listed. */
export function originAllowed(req: Request, env: HttpEnv): boolean {
  const origin = req.headers.get('Origin');
  if (!origin) return true;
  const list = allowedOrigins(env);
  return list.includes('*') || list.includes(origin);
}

export function corsHeaders(req: Request, env: HttpEnv): Record<string, string> {
  const origin = req.headers.get('Origin');
  const list = allowedOrigins(env);
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (list.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (origin && list.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

// ── Best-effort per-IP fixed-window rate limit (per Worker isolate) ──
export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMITS = { create: 10, join: 30, sync: 300 } as const;
export type RateKind = keyof typeof RATE_LIMITS;
export type RateLimiter = (kind: RateKind, ip: string, now?: number) => boolean;

export function createRateLimiter(limits: Record<RateKind, number> = RATE_LIMITS): RateLimiter {
  const buckets = new Map<string, { start: number; count: number }>();
  return (kind, ip, now = Date.now()) => {
    const key = `${kind}:${ip}`;
    const b = buckets.get(key);
    if (!b || now - b.start >= RATE_WINDOW_MS) {
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) if (now - v.start >= RATE_WINDOW_MS) buckets.delete(k);
      }
      buckets.set(key, { start: now, count: 1 });
      return true;
    }
    b.count++;
    return b.count <= limits[kind];
  };
}

export function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
}

export function json(req: Request, env: HttpEnv, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req, env), ...extra },
  });
}

export function tooMany(req: Request, env: HttpEnv): Response {
  return json(req, env, { error: 'Too many requests — try again in a minute' }, 429, { 'Retry-After': '60' });
}
