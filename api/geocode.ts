import { enforceRateLimit, requireFirebaseUser, type VercelRequest, type VercelResponse } from './_lib/security.js';

const mapsKey = () => {
  const key = process.env.GOOGLE_MAPS_API_KEY?.replace(/^\uFEFF/, '').trim();
  if (!key) throw new Error('MAPS_CONFIG');
  return key;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.setHeader('Allow', 'POST').status(405).json({ error: 'Method not allowed.' });
  try {
    const { latitude, longitude } = req.body ?? {};
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Invalid photo coordinates.' });
    }

    const forwarded = (req.headers as Record<string, string | undefined>)['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const actor = req.headers.authorization ? await requireFirebaseUser(req) : `guest:${forwarded}`;
    enforceRateLimit(actor, 'geocode', 20, 60 * 60_000);

    const url = new URL(`https://geocode.googleapis.com/v4/geocode/location/${latitude},${longitude}`);
    url.searchParams.set('languageCode', 'en');
    const response = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': mapsKey(),
        'X-Goog-FieldMask': 'results.formattedAddress,results.placeId',
      },
    });
    const payload = await response.json() as { results?: Array<{ formattedAddress?: string; placeId?: string }>; error?: { message?: string } };
    if (!response.ok) {
      console.error('Google geocoding error:', response.status, payload.error?.message);
      throw new Error('GEOCODE_FAILED');
    }
    const result = payload.results?.find(item => item.formattedAddress);
    if (!result?.formattedAddress) return res.status(404).json({ error: 'No street address was found near this photo.' });
    return res.status(200).json({ address: result.formattedAddress, placeId: result.placeId });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHORIZED') return res.status(401).json({ error: 'Please sign in again to use photo location.' });
    if (code === 'RATE_LIMIT') return res.status(429).json({ error: 'Too many address lookups. Please try again later.' });
    if (code === 'MAPS_CONFIG') return res.status(503).json({ error: 'Google Maps address lookup is not configured yet.' });
    console.error('Geocoding endpoint error:', error);
    return res.status(502).json({ error: 'Google Maps could not resolve this photo location.' });
  }
}
