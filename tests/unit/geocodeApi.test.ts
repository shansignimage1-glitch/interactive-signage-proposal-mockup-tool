import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../../api/geocode';

const originalKey = process.env.GOOGLE_MAPS_API_KEY;

const response = () => {
  const result: { statusCode?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  const res = {
    setHeader: (name: string, value: string) => { result.headers[name] = value; return res; },
    status: (code: number) => { result.statusCode = code; return res; },
    json: (body: unknown) => { result.body = body; return res; },
  };
  return { result, res };
};

describe('Google Maps reverse-geocoding endpoint', () => {
  beforeEach(() => { process.env.GOOGLE_MAPS_API_KEY = 'maps-test-key'; });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  });

  it('returns only the closest formatted address and keeps the key in a request header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [{ formattedAddress: '1 Test Street, Cape Town, South Africa', placeId: 'place-1' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { result, res } = response();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': '127.0.0.1' } as any, body: { latitude: -33.9249, longitude: 18.4241 } }, res);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ address: '1 Test Street, Cape Town, South Africa', placeId: 'place-1' });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ 'X-Goog-Api-Key': 'maps-test-key', 'X-Goog-FieldMask': 'results.formattedAddress,results.placeId' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('-33.9249,18.4241');
  });

  it('rejects invalid coordinates before calling Google', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { result, res } = response();
    await handler({ method: 'POST', headers: {}, body: { latitude: 120, longitude: 18 } }, res);
    expect(result.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
