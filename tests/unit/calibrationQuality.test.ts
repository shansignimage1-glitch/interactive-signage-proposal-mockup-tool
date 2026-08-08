import { describe, expect, it } from 'vitest';
import { assessCalibrationQuality, isOrderedCalibrationQuad } from '../../utils/calibrationQuality';

const imageSize = { width: 1000, height: 800 };

describe('calibration quality guidance', () => {
  it('rejects incomplete and tiny line references', () => {
    expect(assessCalibrationQuality('line', [{ x: 0, y: 0 }], imageSize).valid).toBe(false);
    expect(assessCalibrationQuality('line', [{ x: 0, y: 0 }, { x: 10, y: 0 }], imageSize).valid).toBe(false);
  });

  it('rewards longer line references', () => {
    const result = assessCalibrationQuality('line', [{ x: 50, y: 100 }, { x: 350, y: 100 }], imageSize);
    expect(result.valid).toBe(true);
    expect(result.level).toBe('good');
  });

  it('accepts clockwise and counter-clockwise wall rectangles', () => {
    const clockwise = [{ x: 100, y: 100 }, { x: 800, y: 120 }, { x: 760, y: 650 }, { x: 130, y: 620 }];
    expect(isOrderedCalibrationQuad(clockwise)).toBe(true);
    expect(isOrderedCalibrationQuad([...clockwise].reverse())).toBe(true);
    expect(assessCalibrationQuality('plane', clockwise, imageSize).level).toBe('good');
  });

  it('rejects crossed wall corners', () => {
    const crossed = [{ x: 100, y: 100 }, { x: 800, y: 650 }, { x: 800, y: 100 }, { x: 100, y: 650 }];
    const result = assessCalibrationQuality('plane', crossed, imageSize);
    expect(result.valid).toBe(false);
    expect(result.level).toBe('invalid');
  });
});
