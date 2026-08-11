import { describe, expect, it } from 'vitest';
import { elementDetectionTestables } from '../../utils/elementDetection';

const imageData = (width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): ImageData => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
};

describe('classical element detection', () => {
  it('uses transparency as the foreground mask', () => {
    const data = imageData(10, 10, (x, y) => x >= 3 && x <= 6 && y >= 3 && y <= 6 ? [255, 0, 0, 255] : [0, 0, 0, 0]);
    const mask = elementDetectionTestables.binarize(data, 0.5);
    expect(mask.reduce((sum, value) => sum + value, 0)).toBe(16);
  });

  it('separates disconnected elements and records exact areas', () => {
    const mask = new Uint8Array(8 * 5);
    for (const [x, y] of [[1,1],[2,1],[1,2],[2,2],[5,1],[6,1],[5,2],[6,2]]) mask[y * 8 + x] = 1;
    const result = elementDetectionTestables.labelComponents(mask, 8, 5);
    expect(result.components.map(component => component.area)).toEqual([4, 4]);
  });

  it('traces and simplifies a closed rectangle without collapsing it', () => {
    const mask = new Uint8Array(10 * 10);
    for (let y = 2; y <= 7; y++) for (let x = 2; x <= 7; x++) mask[y * 10 + x] = 1;
    const { labels, components } = elementDetectionTestables.labelComponents(mask, 10, 10);
    const contour = elementDetectionTestables.traceBoundary(labels, 10, 10, components[0]);
    const simplified = elementDetectionTestables.simplifyClosed(contour, 1.2);
    expect(contour.length).toBeGreaterThan(10);
    expect(simplified.length).toBeGreaterThanOrEqual(4);
  });

  it('finds an enclosed counter as a hole contour', () => {
    const mask = new Uint8Array(12 * 12);
    for (let y = 2; y <= 9; y++) for (let x = 2; x <= 9; x++) mask[y * 12 + x] = 1;
    for (let y = 5; y <= 6; y++) for (let x = 5; x <= 6; x++) mask[y * 12 + x] = 0;
    const { labels, components } = elementDetectionTestables.labelComponents(mask, 12, 12);
    const holes = elementDetectionTestables.traceHoles(labels, 12, 12, components[0]);
    expect(holes).toHaveLength(1);
    expect(holes[0].length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a thin perimeter keyline without rejecting dense artwork', () => {
    const frame = { label: 1, area: 144, minX: 2, minY: 1, maxX: 37, maxY: 18 };
    const filledLogo = { label: 2, area: 420, minX: 4, minY: 2, maxX: 34, maxY: 17 };
    expect(elementDetectionTestables.isLikelyPerimeterFrame(frame, 40, 20)).toBe(true);
    expect(elementDetectionTestables.isLikelyPerimeterFrame(filledLogo, 40, 20)).toBe(false);
  });
});
