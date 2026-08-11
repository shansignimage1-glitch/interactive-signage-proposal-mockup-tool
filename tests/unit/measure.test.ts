import { describe, expect, it } from 'vitest';
import { formatLength, getMmPerPx, imagePointToPlane, measureBox, measureLine, measureSignSizeMm, moveSignOnPlane, resizeSignToRealSize, scaleSignOnPlane, toMm } from '../../utils/measure';
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

    const initial = [
      { x: 220, y: 160 }, { x: 340, y: 166 }, { x: 334, y: 220 }, { x: 225, y: 216 },
    ] as const;
    const resized = resizeSignToRealSize([...initial], 2000, 500, calibration);
    expect(resized).not.toBeNull();
    const measured = measureSignSizeMm(resized!, calibration);
    expect(measured?.width).toBeCloseTo(2000, 5);
    expect(measured?.height).toBeCloseTo(500, 5);

    const scaled = scaleSignOnPlane(resized!, 1.5, 1.5, calibration);
    const scaledSize = measureSignSizeMm(scaled, calibration);
    expect(scaledSize?.width).toBeCloseTo(3000, 5);
    expect(scaledSize?.height).toBeCloseTo(750, 5);

    const moved = moveSignOnPlane(resized!, { x: 280, y: 190 }, { x: 360, y: 250 }, calibration);
    const movedSize = measureSignSizeMm(moved, calibration);
    expect(movedSize?.width).toBeCloseTo(2000, 5);
    expect(movedSize?.height).toBeCloseTo(500, 5);
  });

  it('measures an offset plane in its derived world coordinates', () => {
    const corners = [{x:200,y:180},{x:760,y:220},{x:720,y:650},{x:230,y:620}] as [
      {x:number;y:number}, {x:number;y:number}, {x:number;y:number}, {x:number;y:number}
    ];
    const worldCornersMm = [{x:400,y:250},{x:3400,y:250},{x:3400,y:2250},{x:400,y:2250}] as typeof corners;
    const plane = {
      id: 'wall-2', name: 'Wall 2', corners, widthMm: 3000, heightMm: 2000,
      worldCornersMm, referencePlaneId: 'wall-1', offsetMm: 500,
      calibrationKind: 'parallel-offset' as const, cameraConfidence: 'estimated' as const,
    };
    const calibration: Calibration = {
      start: corners[0], end: corners[1], realValue: 3000, unit: 'mm',
      plane: { corners, widthMm: 3000, heightMm: 2000 },
      planes: [plane], activePlaneId: plane.id,
    };
    const mapped = imagePointToPlane(corners[0], calibration);
    expect(mapped?.x).toBeCloseTo(worldCornersMm[0].x, 6);
    expect(mapped?.y).toBeCloseTo(worldCornersMm[0].y, 6);
    expect(measureLine(corners[0], corners[1], calibration, 'metric')).toBe('3.00m');
    expect(measureBox(corners[0], corners[2], calibration, 'metric')).toBe('3.00m × 2.00m');
  });
});
