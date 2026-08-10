import { MAX_SOURCE_BYTES } from './imageProcessing';

export interface LevelDimensions { width: number; height: number }

export const levelCorrectionDegrees = (start: { x: number; y: number }, end: { x: number; y: number }) =>
  -Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;

// Largest centred axis-aligned rectangle that contains no empty pixels after rotation.
export const largestContainedRect = (width: number, height: number, radians: number): LevelDimensions => {
  const w = Math.abs(width);
  const h = Math.abs(height);
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  if (sin < 1e-7) return { width: Math.floor(w), height: Math.floor(h) };

  const widthLonger = w >= h;
  const sideLong = widthLonger ? w : h;
  const sideShort = widthLonger ? h : w;
  let croppedWidth: number;
  let croppedHeight: number;

  if (sideShort <= 2 * sin * cos * sideLong || Math.abs(sin - cos) < 1e-7) {
    const x = 0.5 * sideShort;
    croppedWidth = widthLonger ? x / sin : x / cos;
    croppedHeight = widthLonger ? x / cos : x / sin;
  } else {
    const cos2 = cos * cos - sin * sin;
    croppedWidth = (w * cos - h * sin) / cos2;
    croppedHeight = (h * cos - w * sin) / cos2;
  }

  return {
    width: Math.max(1, Math.floor(croppedWidth)),
    height: Math.max(1, Math.floor(croppedHeight)),
  };
};

const canvasDataUrl = (canvas: HTMLCanvasElement, mime: string) => new Promise<string>((resolve, reject) => {
  canvas.toBlob(blob => {
    if (!blob) { reject(new Error('The levelled photo could not be encoded.')); return; }
    if (blob.size > MAX_SOURCE_BYTES) { reject(new Error('The levelled photo exceeds 40 MB. Use a smaller source photo.')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('The levelled photo could not be read.'));
    reader.readAsDataURL(blob);
  }, mime, 0.98);
});

export const levelImage = async (image: HTMLImageElement, sourceDataUrl: string, correctionDegrees: number) => {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const radians = correctionDegrees * Math.PI / 180;
  const output = largestContainedRect(sourceWidth, sourceHeight, radians);
  if (output.width * output.height > 48_000_000) {
    throw new Error('This photo is too large to rotate safely on this device. Reduce it below 48 megapixels and try again.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This device could not allocate the full-resolution level canvas.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.translate(output.width / 2, output.height / 2);
  context.rotate(radians);
  context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2);

  const sourceMime = sourceDataUrl.match(/^data:(image\/(?:png|jpe?g|webp));/i)?.[1]?.toLowerCase();
  const outputMime = sourceMime === 'image/png' ? 'image/png' : sourceMime === 'image/webp' ? 'image/webp' : 'image/jpeg';
  return canvasDataUrl(canvas, outputMime);
};
