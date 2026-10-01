import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enforceDailyBudget, enforceRateLimit } from '../../api/_lib/security';

const ENV_KEYS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'DAILY_BUDGET_CLEANUP'];
const saved: Record<string, string | undefined> = {};
let unique = 0;
const actor = () => `user-${Date.now()}-${unique++}`;

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe('rate limiting without shared storage (per-instance fallback)', () => {
  it('allows up to the limit, then rejects', async () => {
    const id = actor();
    for (let i = 0; i < 3; i++) await expect(enforceRateLimit(id, 'test', 3, 60_000)).resolves.toBeUndefined();
    await expect(enforceRateLimit(id, 'test', 3, 60_000)).rejects.toThrow('RATE_LIMIT');
  });

  it('keeps callers and actions independent', async () => {
    const a = actor(), b = actor();
    await enforceRateLimit(a, 'test', 1, 60_000);
    await expect(enforceRateLimit(b, 'test', 1, 60_000)).resolves.toBeUndefined();
    await expect(enforceRateLimit(a, 'other', 1, 60_000)).resolves.toBeUndefined();
  });
});

describe('rate limiting with Upstash Redis (shared across instances)', () => {
  const stubRedis = (count: number | (() => Response)) => {
    const fetchMock = vi.fn(async () => typeof count === 'function'
      ? count()
      : new Response(JSON.stringify([{ result: count }, { result: 1 }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('uses the shared counter from the Marketplace env vars', async () => {
    process.env.KV_REST_API_URL = 'https://redis.example.upstash.io/';
    process.env.KV_REST_API_TOKEN = 'secret-token';
    const fetchMock = stubRedis(21);

    await expect(enforceRateLimit('uid-1', 'assistant', 20, 60_000)).rejects.toThrow('RATE_LIMIT');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://redis.example.upstash.io/pipeline');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const commands = JSON.parse(String(init.body));
    expect(commands[0][0]).toBe('INCR');
    expect(commands[0][1]).toMatch(/^sp:rl:assistant:uid-1:\d+$/);
    expect(commands[1][0]).toBe('PEXPIRE');
  });

  it('also accepts the UPSTASH_REDIS_REST_* variable names', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'secret-token';
    stubRedis(1);
    await expect(enforceRateLimit('uid-2', 'assistant', 20, 60_000)).resolves.toBeUndefined();
  });

  it('falls back to per-instance limits when Redis is unavailable, never blocking users', async () => {
    process.env.KV_REST_API_URL = 'https://redis.example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret-token';
    stubRedis(() => new Response('down', { status: 503 }));
    const id = actor();
    await expect(enforceRateLimit(id, 'test', 1, 60_000)).resolves.toBeUndefined();
    await expect(enforceRateLimit(id, 'test', 1, 60_000)).rejects.toThrow('RATE_LIMIT');
  });
});

describe('daily budgets (all callers combined)', () => {
  it('rejects once the endpoint-wide daily total is exceeded', async () => {
    process.env.KV_REST_API_URL = 'https://redis.example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret-token';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ result: 201 }, { result: 1 }]))));
    await expect(enforceDailyBudget('cleanup', 200)).rejects.toThrow('DAILY_BUDGET');
  });

  it('can be raised with an environment variable', async () => {
    process.env.KV_REST_API_URL = 'https://redis.example.upstash.io';
    process.env.KV_REST_API_TOKEN = 'secret-token';
    process.env.DAILY_BUDGET_CLEANUP = '500';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ result: 201 }, { result: 1 }]))));
    await expect(enforceDailyBudget('cleanup', 200)).resolves.toBeUndefined();
  });
});
