import { Point, Size } from '../types';
import { distance } from './math';

export type CalibrationMethod = 'line' | 'plane';
export type CalibrationQualityLevel = 'good' | 'fair' | 'poor' | 'invalid';

export interface CalibrationQuality {
  level: CalibrationQualityLevel;
  valid: boolean;
  title: string;
  message: string;
  coverage: number;
}

const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const segmentsCross = (a: Point, b: Point, c: Point, d: Point) => {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
};

const polygonArea = (points: Point[]) => Math.abs(points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0)) / 2;

export const isOrderedCalibrationQuad = (points: Point[]): boolean => {
  if (points.length !== 4) return false;
  if (segmentsCross(points[0], points[1], points[2], points[3])) return false;
  if (segmentsCross(points[1], points[2], points[3], points[0])) return false;
  const turns = points.map((point, index) => cross(point, points[(index + 1) % 4], points[(index + 2) % 4]));
  return turns.every(turn => turn > 0) || turns.every(turn => turn < 0);
};

export const assessCalibrationQuality = (
  method: CalibrationMethod,
  points: Point[],
  imageSize: Size,
): CalibrationQuality => {
  const imageMax = Math.max(imageSize.width, imageSize.height, 1);

  if (method === 'line') {
    if (points.length !== 2) {
      return { level: 'invalid', valid: false, title: 'Reference incomplete', message: 'Place both reference points.', coverage: 0 };
    }
    const coverage = distance(points[0], points[1]) / imageMax;
    if (coverage < 0.03) {
      return { level: 'invalid', valid: false, title: 'Reference is too short', message: 'Use a longer known edge or zoom in and adjust both points.', coverage };
    }
    if (coverage >= 0.2) {
      return { level: 'good', valid: true, title: 'Good reference length', message: 'The reference spans a useful portion of the photo.', coverage };
    }
    if (coverage >= 0.1) {
      return { level: 'fair', valid: true, title: 'Usable reference', message: 'A longer known edge would improve accuracy.', coverage };
    }
    return { level: 'poor', valid: true, title: 'Small reference', message: 'Accuracy may suffer. Use the longest known edge available.', coverage };
  }

  if (points.length !== 4) {
    return { level: 'invalid', valid: false, title: 'Wall plane incomplete', message: `Place all four corners (${points.length}/4).`, coverage: 0 };
  }
  if (!isOrderedCalibrationQuad(points)) {
    return { level: 'invalid', valid: false, title: 'Corners cross or are out of order', message: 'Place corners clockwise: top-left, top-right, bottom-right, bottom-left.', coverage: 0 };
  }

  const coverage = polygonArea(points) / Math.max(imageSize.width * imageSize.height, 1);
  const shortestEdge = Math.min(...points.map((point, index) => distance(point, points[(index + 1) % 4]))) / imageMax;
  if (coverage < 0.01 || shortestEdge < 0.02) {
    return { level: 'invalid', valid: false, title: 'Reference plane is too small', message: 'Choose a larger rectangle on the same wall plane.', coverage };
  }
  if (coverage >= 0.15) {
    return { level: 'good', valid: true, title: 'Good wall coverage', message: 'The reference covers a useful area of the facade.', coverage };
  }
  if (coverage >= 0.06) {
    return { level: 'fair', valid: true, title: 'Usable wall coverage', message: 'A larger rectangle would improve perspective accuracy.', coverage };
  }
  return { level: 'poor', valid: true, title: 'Small wall reference', message: 'Use the largest known rectangle available on this wall.', coverage };
};
