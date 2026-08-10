import { auth } from '../firebase';

export interface PhotoCoordinates { latitude: number; longitude: number; accuracy?: number }
export interface ResolvedPhotoLocation extends PhotoCoordinates { address: string; placeId?: string; source: 'photo' | 'device' }

export async function coordinatesFromPhoto(file: File): Promise<PhotoCoordinates | null> {
  try {
    // EXIF parsing is loaded only when location is explicitly enabled, keeping
    // the metadata parser out of the normal editor bundle.
    const { gps } = await import('exifr');
    const result = await gps(file);
    if (!result || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) return null;
    return { latitude: result.latitude, longitude: result.longitude };
  } catch {
    return null;
  }
}

export const currentCoordinates = () => new Promise<PhotoCoordinates>((resolve, reject) => {
  if (!navigator.geolocation) { reject(new Error('Location is not supported on this device.')); return; }
  navigator.geolocation.getCurrentPosition(
    position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
    error => reject(new Error(error.code === error.PERMISSION_DENIED ? 'Location permission was not granted.' : 'The current location could not be determined.')),
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
  );
});

export async function reverseGeocode(coordinates: PhotoCoordinates, source: 'photo' | 'device'): Promise<ResolvedPhotoLocation> {
  const token = await auth.currentUser?.getIdToken();
  const response = await fetch('/api/geocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ latitude: coordinates.latitude, longitude: coordinates.longitude }),
  });
  const payload = await response.json().catch(() => ({})) as { address?: string; placeId?: string; error?: string };
  if (!response.ok || !payload.address) throw new Error(payload.error || `Address lookup failed (${response.status}).`);
  return { ...coordinates, address: payload.address, placeId: payload.placeId, source };
}
