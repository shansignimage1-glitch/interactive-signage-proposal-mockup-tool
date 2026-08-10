import { describe, expect, it } from 'vitest';
import { largestContainedRect, levelCorrectionDegrees } from '../../services/imageLeveling';

describe('image leveling geometry', () => {
  it('rotates a sloping reference line back to horizontal', () => {
    expect(levelCorrectionDegrees({ x: 10, y: 10 }, { x: 110, y: 30 })).toBeCloseTo(-11.31, 2);
  });

  it('retains the complete frame when no correction is needed', () => {
    expect(largestContainedRect(4000, 3000, 0)).toEqual({ width: 4000, height: 3000 });
  });

  it('crops rotated corners without increasing source dimensions', () => {
    const result = largestContainedRect(4000, 3000, 8 * Math.PI / 180);
    expect(result.width).toBeLessThan(4000);
    expect(result.height).toBeLessThan(3000);
    expect(result.width).toBeGreaterThan(3000);
    expect(result.height).toBeGreaterThan(2000);
  });
});
