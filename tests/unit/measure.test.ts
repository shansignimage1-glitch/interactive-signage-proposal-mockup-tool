import { describe, expect, it } from 'vitest';
import { formatLength, getMmPerPx, measureBox, measureLine, toMm } from '../../utils/measure';
import type { Calibration } from '../../types';

describe('measurement conversion and calibration', () => {
  it('converts supported real-world units to millimetres', () => {
    expect(toMm(2, 'm')).toBe(2000);
    expect(toMm(8.56, 'cm')).toBeCloseTo(85.6);
    expect(toMm(12, 'in')).toBeCloseTo(304.8);
    expect(toMm(2, 'ft')).toBeCloseTo(609.6);
  });

  it('derives scale from intrinsic image coordinates', () => {
    expect(getMmPerPx({ start: { x: 10, y: 10 }, end: { x: 110, y: 10 }, realValue: 1, unit: 'm' })).toBe(10);
  });

  it('rejects degenerate calibration lines', () => {
    expect(getMmPerPx({ start: { x: 1, y: 1 }, end: { x: 1, y: 1 }, realValue: 1, unit: 'm' })).toBeNull();
  });

  it('automatically measures lines and boxes in metric and imperial', () => {
    const calibration = { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, realValue: 1, unit: 'm' as const };
    expect(measureLine({ x: 0, y: 0 }, { x: 240, y: 0 }, calibration, 'metric')).toBe('2.40m');
    expect(measureBox({ x: 0, y: 0 }, { x: 60, y: 120 }, calibration, 'metric')).toBe('60cm × 1.20m');
    expect(formatLength(2895.6, 'imperial')).toBe(`9'6"`);
  });

  it('rectifies measurements on a perspective-skewed wall plane', () => {
    const calibration: Calibration = {
      start: { x: 100, y: 50 }, end: { x: 500, y: 80 }, realValue: 4, unit: 'm' as const,
      plane: {
        corners: [{ x: 100, y: 50 }, { x: 500, y: 80 }, { x: 450, y: 350 }, { x: 140, y: 330 }],
        widthMm: 4000,
        heightMm: 3000,
      },
    };
    expect(measureLine(calibration.plane.corners[0], calibration.plane.corners[1], calibration, 'metric')).toBe('4.00m');
    expect(measureBox(calibration.plane.corners[0], calibration.plane.corners[2], calibration, 'metric')).toBe('4.00m × 3.00m');
  });
});
