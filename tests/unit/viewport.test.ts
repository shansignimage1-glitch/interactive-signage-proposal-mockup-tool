import { describe, expect, it } from 'vitest';
import { clampViewScale, viewForPinch, zoomViewAtPoint } from '../../utils/viewport';

const viewport = { width: 1000, height: 800 };
const content = { width: 2000, height: 1000 };

describe('canvas viewport gestures', () => {
  it('clamps zoom to the supported range', () => {
    expect(clampViewScale(0.01)).toBe(0.25);
    expect(clampViewScale(20)).toBe(8);
  });

  it('keeps the content coordinate beneath the zoom focal point', () => {
    const start = { scale: 1, x: 40, y: -20 };
    const point = { x: 760, y: 210 };
    const before = {
      x: (point.x - viewport.width / 2 - start.x) / 0.5 + content.width / 2,
      y: (point.y - viewport.height / 2 - start.y) / 0.5 + content.height / 2,
    };
    const result = zoomViewAtPoint(start, 2, point, viewport, content, 0.5);
    const after = {
      x: (point.x - viewport.width / 2 - result.x) / (0.5 * result.scale) + content.width / 2,
      y: (point.y - viewport.height / 2 - result.y) / (0.5 * result.scale) + content.height / 2,
    };

    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('combines pinch zoom with centroid panning', () => {
    const result = viewForPinch(
      { scale: 1, x: 0, y: 0 },
      { x: 500, y: 400 },
      { x: 550, y: 430 },
      100,
      200,
      viewport,
      content,
      0.5,
    );

    expect(result.scale).toBe(2);
    expect(result.x).toBe(50);
    expect(result.y).toBe(30);
  });
});
