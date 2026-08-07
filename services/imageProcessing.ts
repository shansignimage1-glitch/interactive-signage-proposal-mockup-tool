import { blobToDataUri, dataUriToBlob } from './imageHash';

export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 80_000_000;
export const DEFAULT_MAX_DIMENSION = 4096;

export class ImageTooLargeError extends Error { name = 'ImageTooLargeError'; }
export class StorageQuotaError extends Error { name = 'StorageQuotaError'; }

type DecodedImage = CanvasImageSource & { width: number; height: number; close: () => void };

const decode = async (blob: Blob): Promise<DecodedImage> => {
  if (blob.size > MAX_SOURCE_BYTES) throw new ImageTooLargeError('This photo is larger than 40 MB. Use the device photo editor to reduce it first.');
  let bitmap: DecodedImage;
  if ('createImageBitmap' in globalThis) {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }) as DecodedImage;
  } else {
    // Older iPadOS/Safari builds may not expose createImageBitmap. Keep a
    // normal image-element path so field uploads still work on those devices.
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    await image.decode();
    bitmap = Object.assign(image, { close: () => URL.revokeObjectURL(url) }) as DecodedImage;
  }
  if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) {
    bitmap.close();
    throw new ImageTooLargeError('This photo exceeds 80 megapixels and cannot be processed safely on this device.');
  }
  return bitmap;
};

export const optimizeImageBlob = async (blob: Blob, maxDimension = DEFAULT_MAX_DIMENSION): Promise<Blob> => {
  const bitmap = await decode(blob);
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && blob.size <= 8 * 1024 * 1024) { bitmap.close(); return blob; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { alpha: true })!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const preserveTransparency = blob.type === 'image/png' || blob.type === 'image/webp';
  const type = preserveTransparency ? 'image/webp' : 'image/jpeg';
  return new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image compression failed')), type, 0.86));
};

export const optimizeImageFile = async (file: File, maxDimension = DEFAULT_MAX_DIMENSION): Promise<string> =>
  blobToDataUri(await optimizeImageBlob(file, maxDimension));

export const optimizeDataUri = async (dataUri: string, maxDimension = DEFAULT_MAX_DIMENSION): Promise<string> => {
  const optimized = await optimizeImageBlob(dataUriToBlob(dataUri), maxDimension);
  return blobToDataUri(optimized);
};

export const assertStorageCapacity = async (bytesNeeded: number): Promise<void> => {
  const estimate = await navigator.storage?.estimate?.();
  if (!estimate?.quota) return;
  const remaining = estimate.quota - (estimate.usage ?? 0);
  if (remaining < bytesNeeded * 1.25) throw new StorageQuotaError(`Not enough device storage. Free approximately ${Math.ceil((bytesNeeded * 1.25 - remaining) / 1048576)} MB and try again.`);
};
