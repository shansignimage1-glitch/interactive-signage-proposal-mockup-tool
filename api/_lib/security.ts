import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface VercelRequest {
  method?: string;
  headers: { authorization?: string };
  body?: any;
}

export interface VercelResponse {
  setHeader(name: string, value: string): VercelResponse;
  status(code: number): VercelResponse;
  json(body: unknown): VercelResponse;
}

const PROJECT_ID = 'sunny-ship-437805-c5';
const FIREBASE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
type LimitState = { count: number; resetAt: number };
const limits = new Map<string, LimitState>();

export function allowPost(req: VercelRequest, res: VercelResponse): boolean {
  if (req.method === 'POST') return true;
  res.setHeader('Allow', 'POST').status(405).json({ error: 'Method not allowed.' });
  return false;
}

// jose error codes that mean "this token is not valid" (expired, bad
// signature, wrong issuer/audience, malformed, unknown key id). A JWKS network
// failure (ERR_JWKS_TIMEOUT etc.) is NOT the caller's fault and stays a 5xx.
const INVALID_TOKEN_CODE = /^ERR_(JWT_|JWS_|JWKS_NO_MATCHING_KEY|JWKS_MULTIPLE_MATCHING_KEYS)/;

export async function requireFirebaseUser(req: VercelRequest): Promise<string> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new Error('UNAUTHORIZED');
  let payload;
  try {
    ({ payload } = await jwtVerify(header.slice(7), FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${PROJECT_ID}`,
      audience: PROJECT_ID,
    }));
  } catch (error) {
    // Expired/invalid tokens must return 401 so the client re-authenticates;
    // they previously fell through to a generic 500/502.
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && INVALID_TOKEN_CODE.test(code)) throw new Error('UNAUTHORIZED');
    throw error;
  }
  if (!payload.sub) throw new Error('UNAUTHORIZED');
  return payload.sub;
}

// --- Rate limits and daily budgets ---------------------------------------
// Serverless instances are many and short-lived, so per-instance counters
// barely limit anything. When Upstash Redis is connected (Vercel Marketplace
// creates KV_REST_API_URL / KV_REST_API_TOKEN), counters are shared by every
// instance. Without it, or if Redis is unreachable, the per-instance
// in-memory counters are used so the app keeps working.

const redisConfig = (): { url: string; token: string } | null => {
  const url = (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL)?.trim();
  const token = (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN)?.trim();
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
};

/** Shared INCR for a window-scoped key; null means "use the local fallback". */
const sharedIncrement = async (key: string, windowMs: number): Promise<number | null> => {
  const redis = redisConfig();
  if (!redis) return null;
  try {
    const response = await fetch(`${redis.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redis.token}`, 'Content-Type': 'application/json' },
      // Keys already carry the window number, so the TTL only needs to outlive it.
      body: JSON.stringify([['INCR', key], ['PEXPIRE', key, String(windowMs * 2)]]),
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    const results = await response.json() as Array<{ result?: unknown }>;
    const count = Number(results?.[0]?.result);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
};

const localIncrement = (key: string, windowMs: number): number => {
  const now = Date.now();
  // A warm instance lives for many requests; drop expired windows so the map
  // cannot grow without bound.
  if (limits.size > 5_000) {
    for (const [staleKey, state] of limits) if (state.resetAt <= now) limits.delete(staleKey);
  }
  const current = limits.get(key);
  if (!current || current.resetAt <= now) {
    limits.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  current.count += 1;
  return current.count;
};

/** Number of calls so far in the current fixed window, this one included. */
const countInWindow = async (key: string, windowMs: number): Promise<number> => {
  const windowKey = `${key}:${Math.floor(Date.now() / windowMs)}`;
  return (await sharedIncrement(`sp:rl:${windowKey}`, windowMs)) ?? localIncrement(windowKey, windowMs);
};

/** Per-caller limit (a signed-in uid, or a guest's IP). */
export async function enforceRateLimit(actor: string, action: string, max: number, windowMs: number): Promise<void> {
  if (await countInWindow(`${action}:${actor}`, windowMs) > max) throw new Error('RATE_LIMIT');
}

const DAY_MS = 86_400_000;

/**
 * Total calls to one endpoint across ALL callers per UTC day. This caps the
 * worst-case bill even if someone creates many accounts. Override a default
 * with an env var such as DAILY_BUDGET_CLEANUP=500.
 */
export async function enforceDailyBudget(action: string, defaultMaxPerDay: number): Promise<void> {
  const override = Number(process.env[`DAILY_BUDGET_${action.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]);
  const max = Number.isFinite(override) && override > 0 ? override : defaultMaxPerDay;
  if (await countInWindow(`budget:${action}`, DAY_MS) > max) throw new Error('DAILY_BUDGET');
}

export function requireApiKey(): string {
  // Environment values copied from text editors or PowerShell can contain a
  // UTF-8 byte-order mark. Undici rejects that invisible U+FEFF character in
  // the x-goog-api-key header before the request ever reaches Gemini.
  const key = process.env.GEMINI_API_KEY?.replace(/^\uFEFF/, '').trim();
  if (!key) throw new Error('SERVER_CONFIG');
  return key;
}

export function sendApiError(res: VercelResponse, error: unknown): void {
  const code = error instanceof Error ? error.message : '';
  if (code === 'UNAUTHORIZED') res.status(401).json({ error: 'Please sign in again to use AI features.' });
  else if (code === 'RATE_LIMIT') res.status(429).json({ error: 'AI usage limit reached. Please wait a few minutes and try again.' });
  else if (code === 'DAILY_BUDGET') res.status(429).json({ error: 'The app\'s daily AI allowance has been reached. Please try again tomorrow.' });
  else if (code === 'SERVER_CONFIG') res.status(503).json({ error: 'AI is not configured on the server.' });
  else {
    console.error('AI endpoint error:', error);
    res.status(500).json({ error: 'The AI service could not complete this request.' });
  }
}
