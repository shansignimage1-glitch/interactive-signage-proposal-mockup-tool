import { Point, Calibration, MeasureUnit, UnitSystem } from '../types';
import { distance } from './math';
import { computeHomography } from './math';
import { getActiveCalibrationPlane } from './cameraGeometry';

// --- Unit conversion ---

const MM_PER_UNIT: Record<MeasureUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export const toMm = (value: number, unit: MeasureUnit): number => value * MM_PER_UNIT[unit];

// Millimetres of real-world length represented by one intrinsic image pixel.
// Returns null when the calibration line is degenerate (zero length).
export const getMmPerPx = (cal: Calibration): number | null => {
  const px = distance(cal.start, cal.end);
  if (px < 1) return null;
  return toMm(cal.realValue, cal.unit) / px;
};

const transformPoint = (point: Point, homography: number[]): Point | null => {
  const w = homography[6] * point.x + homography[7] * point.y + homography[8];
  if (Math.abs(w) < 1e-9) return null;
  const transformed = {
    x: (homography[0] * point.x + homography[1] * point.y + homography[2]) / w,
    y: (homography[3] * point.x + homography[4] * point.y + homography[5]) / w,
  };
  return Number.isFinite(transformed.x) && Number.isFinite(transformed.y) ? transformed : null;
};

export const imagePointToPlane = (point: Point, cal: Calibration): Point | null => {
  const plane = getActiveCalibrationPlane(cal);
  if (!plane) return null;
  const { corners, widthMm, heightMm } = plane;
  const planeCoordinates = plane.worldCornersMm ?? [
    { x: 0, y: 0 },
    { x: widthMm, y: 0 },
    { x: widthMm, y: heightMm },
    { x: 0, y: heightMm },
  ];
  const h = computeHomography(corners, planeCoordinates);
  return transformPoint(point, h);
};

export const planePointToImage = (point: Point, cal: Calibration): Point | null => {
  const plane = getActiveCalibrationPlane(cal);
  if (!plane) return null;
  const { corners, widthMm, heightMm } = plane;
  const planeCoordinates = plane.worldCornersMm ?? [
    { x: 0, y: 0 },
    { x: widthMm, y: 0 },
    { x: widthMm, y: heightMm },
    { x: 0, y: heightMm },
  ];
  const h = computeHomography(planeCoordinates, corners);
  return transformPoint(point, h);
};

export const measureSignSizeMm = (corners: [Point, Point, Point, Point], cal: Calibration): { width: number; height: number } | null => {
  const measuredCorners = getActiveCalibrationPlane(cal)
    ? corners.map(point => imagePointToPlane(point, cal))
    : corners.map(point => {
        const scale = getMmPerPx(cal);
        return scale === null ? null : { x: point.x * scale, y: point.y * scale };
      });
  if (measuredCorners.some(point => point === null)) return null;
  const [tl, tr, br, bl] = measuredCorners as [Point, Point, Point, Point];
  return {
    width: (distance(tl, tr) + distance(bl, br)) / 2,
    height: (distance(tl, bl) + distance(tr, br)) / 2,
  };
};

const resizeRectangle = (
  corners: [Point, Point, Point, Point],
  width: number,
  height: number,
): [Point, Point, Point, Point] | null => {
  if (!(width > 0) || !(height > 0)) return null;
  const [tl, tr, br, bl] = corners;
  const center = {
    x: corners.reduce((sum, point) => sum + point.x, 0) / corners.length,
    y: corners.reduce((sum, point) => sum + point.y, 0) / corners.length,
  };
  const horizontal = { x: (tr.x - tl.x) + (br.x - bl.x), y: (tr.y - tl.y) + (br.y - bl.y) };
  const horizontalLength = Math.hypot(horizontal.x, horizontal.y);
  if (horizontalLength < 1e-9) return null;
  const xAxis = { x: horizontal.x / horizontalLength, y: horizontal.y / horizontalLength };
  const vertical = { x: (bl.x - tl.x) + (br.x - tr.x), y: (bl.y - tl.y) + (br.y - tr.y) };
  let yAxis = { x: -xAxis.y, y: xAxis.x };
  if (yAxis.x * vertical.x + yAxis.y * vertical.y < 0) yAxis = { x: -yAxis.x, y: -yAxis.y };
  const halfW = width / 2;
  const halfH = height / 2;
  return [
    { x: center.x - xAxis.x * halfW - yAxis.x * halfH, y: center.y - xAxis.y * halfW - yAxis.y * halfH },
    { x: center.x + xAxis.x * halfW - yAxis.x * halfH, y: center.y + xAxis.y * halfW - yAxis.y * halfH },
    { x: center.x + xAxis.x * halfW + yAxis.x * halfH, y: center.y + xAxis.y * halfW + yAxis.y * halfH },
    { x: center.x - xAxis.x * halfW + yAxis.x * halfH, y: center.y - xAxis.y * halfW + yAxis.y * halfH },
  ];
};

export const resizeSignToRealSize = (
  corners: [Point, Point, Point, Point],
  widthMm: number,
  heightMm: number,
  cal: Calibration,
): [Point, Point, Point, Point] | null => {
  if (getActiveCalibrationPlane(cal)) {
    const planeCorners = corners.map(point => imagePointToPlane(point, cal));
    if (planeCorners.some(point => point === null)) return null;
    const resized = resizeRectangle(planeCorners as [Point, Point, Point, Point], widthMm, heightMm);
    if (!resized) return null;
    const projected = resized.map(point => planePointToImage(point, cal));
    return projected.some(point => point === null) ? null : projected as [Point, Point, Point, Point];
  }
  const scale = getMmPerPx(cal);
  return scale === null ? null : resizeRectangle(corners, widthMm / scale, heightMm / scale);
};

export const scaleSignOnPlane = (
  corners: [Point, Point, Point, Point],
  scaleX: number,
  scaleY: number,
  cal: Calibration | null,
): [Point, Point, Point, Point] => {
  if (!getActiveCalibrationPlane(cal)) {
    const center = {
      x: corners.reduce((sum, point) => sum + point.x, 0) / corners.length,
      y: corners.reduce((sum, point) => sum + point.y, 0) / corners.length,
    };
    return corners.map(point => ({ x: center.x + (point.x - center.x) * scaleX, y: center.y + (point.y - center.y) * scaleY })) as [Point, Point, Point, Point];
  }
  const planeCorners = corners.map(point => imagePointToPlane(point, cal));
  if (planeCorners.some(point => point === null)) return corners;
  const points = planeCorners as [Point, Point, Point, Point];
  const center = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  const scaled = points.map(point => ({ x: center.x + (point.x - center.x) * scaleX, y: center.y + (point.y - center.y) * scaleY }));
  const projected = scaled.map(point => planePointToImage(point, cal));
  return projected.some(point => point === null) ? corners : projected as [Point, Point, Point, Point];
};

export const moveSignOnPlane = (
  corners: [Point, Point, Point, Point],
  from: Point,
  to: Point,
  cal: Calibration | null,
): [Point, Point, Point, Point] => {
  if (!getActiveCalibrationPlane(cal)) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return corners.map(point => ({ x: point.x + dx, y: point.y + dy })) as [Point, Point, Point, Point];
  }
  const planeCorners = corners.map(point => imagePointToPlane(point, cal));
  const planeFrom = imagePointToPlane(from, cal);
  const planeTo = imagePointToPlane(to, cal);
  if (planeCorners.some(point => point === null) || !planeFrom || !planeTo) return corners;
  const dx = planeTo.x - planeFrom.x;
  const dy = planeTo.y - planeFrom.y;
  const moved = (planeCorners as Point[]).map(point => ({ x: point.x + dx, y: point.y + dy }));
  const projected = moved.map(point => planePointToImage(point, cal));
  return projected.some(point => point === null) ? corners : projected as [Point, Point, Point, Point];
};

export const measureDistanceMm = (start: Point, end: Point, cal: Calibration): number | null => {
  if (getActiveCalibrationPlane(cal)) {
    const a = imagePointToPlane(start, cal), b = imagePointToPlane(end, cal);
    return a && b ? distance(a, b) : null;
  }
  const scale = getMmPerPx(cal);
  return scale === null ? null : distance(start, end) * scale;
};

// --- Formatting ---

// Metric: 8mm / 60cm / 2.40m — Imperial: 4" / 9'6"
export const formatLength = (mm: number, system: UnitSystem): string => {
  if (!isFinite(mm) || mm < 0) return '?';

  if (system === 'imperial') {
    const totalInches = mm / 25.4;
    if (totalInches < 12) {
      return `${(Math.round(totalInches * 10) / 10)}"`;
    }
    const feet = Math.floor(totalInches / 12);
    const inches = Math.round(totalInches - feet * 12);
    if (inches === 12) return `${feet + 1}'0"`;
    return `${feet}'${inches}"`;
  }

  if (mm < 10) return `${Math.round(mm)}mm`;
  if (mm < 1000) return `${Math.round(mm / 10)}cm`;
  return `${(mm / 1000).toFixed(2)}m`;
};

// --- Measuring drawn shapes ---

export const measureLine = (start: Point, end: Point, cal: Calibration, system: UnitSystem): string => {
  const mm = measureDistanceMm(start, end, cal);
  return mm === null ? '?' : formatLength(mm, system);
};

// Box dimensions read as "width × height"
export const measureBox = (start: Point, end: Point, cal: Calibration, system: UnitSystem): string => {
  if (getActiveCalibrationPlane(cal)) {
    const a = imagePointToPlane(start, cal), b = imagePointToPlane(end, cal);
    if (!a || !b) return '?';
    return `${formatLength(Math.abs(b.x - a.x), system)} × ${formatLength(Math.abs(b.y - a.y), system)}`;
  }
  const mmPerPx = getMmPerPx(cal); if (mmPerPx === null) return '?';
  const w = Math.abs(end.x - start.x) * mmPerPx, h = Math.abs(end.y - start.y) * mmPerPx;
  return `${formatLength(w, system)} × ${formatLength(h, system)}`;
};

// --- Calibration reference presets ---

export interface CalibrationPreset {
  id: string;
  label: string;
  mm: number;
}

export const CALIBRATION_PRESETS: CalibrationPreset[] = [
  { id: 'credit_card', label: 'Credit / bank card width (8.56cm)', mm: 85.6 },
  { id: 'a4_long', label: 'A4 sheet long edge (29.7cm)', mm: 297 },
  { id: 'door_width', label: 'Standard door width (81.3cm)', mm: 813 },
  { id: 'door_height', label: 'Standard door height (2.03m)', mm: 2032 },
  { id: 'brick', label: 'Brick length (22.2cm)', mm: 222 },
];
