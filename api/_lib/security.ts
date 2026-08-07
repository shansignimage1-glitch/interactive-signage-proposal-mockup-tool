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

export async function requireFirebaseUser(req: VercelRequest): Promise<string> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new Error('UNAUTHORIZED');
  const { payload } = await jwtVerify(header.slice(7), FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    audience: PROJECT_ID,
  });
  if (!payload.sub) throw new Error('UNAUTHORIZED');
  return payload.sub;
}

export function enforceRateLimit(uid: string, action: string, max: number, windowMs: number): void {
  const now = Date.now();
  const key = `${uid}:${action}`;
  const current = limits.get(key);
  if (!current || current.resetAt <= now) {
    limits.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (current.count >= max) throw new Error('RATE_LIMIT');
  current.count += 1;
}

export function requireApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('SERVER_CONFIG');
  return key;
}

export function sendApiError(res: VercelResponse, error: unknown): void {
  const code = error instanceof Error ? error.message : '';
  if (code === 'UNAUTHORIZED') res.status(401).json({ error: 'Please sign in again to use AI features.' });
  else if (code === 'RATE_LIMIT') res.status(429).json({ error: 'AI usage limit reached. Please wait a few minutes and try again.' });
  else if (code === 'SERVER_CONFIG') res.status(503).json({ error: 'AI is not configured on the server.' });
  else {
    console.error('AI endpoint error:', error);
    res.status(500).json({ error: 'The AI service could not complete this request.' });
  }
}
