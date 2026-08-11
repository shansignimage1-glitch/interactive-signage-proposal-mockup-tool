import { Calibration, CalibrationPlane, CameraModel, PlacementAnchor, Point } from '../types';
import { computeHomography } from './math';

const transform = (p: Point, h: number[]): Point | null => {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (Math.abs(w) < 1e-10) return null;
  const point = { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
  return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
};

export const getCalibrationPlanes = (calibration: Calibration | null): CalibrationPlane[] => {
  if (!calibration) return [];
  if (calibration.planes?.length) return calibration.planes;
  return calibration.plane ? [{ id: 'legacy-plane', name: 'Wall 1', ...calibration.plane }] : [];
};

export const getActiveCalibrationPlane = (calibration: Calibration | null, planeId?: string): CalibrationPlane | null => {
  const planes = getCalibrationPlanes(calibration);
  return planes.find(p => p.id === (planeId ?? calibration?.activePlaneId)) ?? planes[0] ?? null;
};

export const calibrationForPlane = (calibration: Calibration | null, planeId?: string): Calibration | null => {
  if (!calibration) return null;
  const plane = getActiveCalibrationPlane(calibration, planeId);
  return plane ? {
    ...calibration,
    activePlaneId: plane.id,
    plane: { corners: plane.corners, widthMm: plane.widthMm, heightMm: plane.heightMm },
  } : calibration;
};

const lineIntersection = (a: Point, b: Point, c: Point, d: Point): Point | null => {
  const x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y, x3 = c.x, y3 = c.y, x4 = d.x, y4 = d.y;
  const denominator = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denominator) < 1e-8) return null;
  const x = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denominator;
  const y = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denominator;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
};

export const getVanishingPoints = (plane: CalibrationPlane): { horizontal: Point | null; vertical: Point | null } => ({
  horizontal: lineIntersection(plane.corners[0], plane.corners[1], plane.corners[3], plane.corners[2]),
  vertical: lineIntersection(plane.corners[0], plane.corners[3], plane.corners[1], plane.corners[2]),
});

export const getAnchorPoint = (corners: [Point, Point, Point, Point], anchor: PlacementAnchor = 'center'): Point => {
  const [tl, tr, br, bl] = corners;
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  if (anchor === 'top-left') return tl;
  if (anchor === 'top-center') return mid(tl, tr);
  if (anchor === 'top-right') return tr;
  if (anchor === 'bottom-left') return bl;
  if (anchor === 'bottom-center') return mid(bl, br);
  if (anchor === 'bottom-right') return br;
  return { x: corners.reduce((n, p) => n + p.x, 0) / 4, y: corners.reduce((n, p) => n + p.y, 0) / 4 };
};

export interface SnapResult { corners: [Point, Point, Point, Point]; vertical?: number; horizontal?: number; }

export const snapSign = (
  corners: [Point, Point, Point, Point],
  anchor: PlacementAnchor,
  imageSize: { width: number; height: number },
  plane: CalibrationPlane | null,
  threshold: number,
): SnapResult => {
  const point = getAnchorPoint(corners, anchor);
  const planeCenter = plane ? {
    x: plane.corners.reduce((n, p) => n + p.x, 0) / 4,
    y: plane.corners.reduce((n, p) => n + p.y, 0) / 4,
  } : null;
  const xs = [imageSize.width / 2, ...(planeCenter ? [planeCenter.x] : [])];
  const ys = [imageSize.height / 2, ...(planeCenter ? [planeCenter.y] : [])];
  const sx = xs.find(x => Math.abs(x - point.x) <= threshold);
  const sy = ys.find(y => Math.abs(y - point.y) <= threshold);
  const dx = sx === undefined ? 0 : sx - point.x;
  const dy = sy === undefined ? 0 : sy - point.y;
  return {
    corners: corners.map(p => ({ x: p.x + dx, y: p.y + dy })) as [Point, Point, Point, Point],
    vertical: sx,
    horizontal: sy,
  };
};

const multiplyKInverse = (p: [number, number, number], fx: number, fy: number, cx: number, cy: number): [number, number, number] => [
  (p[0] - cx * p[2]) / fx,
  (p[1] - cy * p[2]) / fy,
  p[2],
];
const norm = (v: number[]) => Math.hypot(...v);
const cross = (a: number[], b: number[]): [number, number, number] => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

/** Decomposes the active plane homography into a pinhole camera pose and projects depth in millimetres. */
export const projectPlaneDepth = (
  corners: [Point, Point, Point, Point],
  plane: CalibrationPlane,
  camera: CameraModel,
  imageSize: { width: number; height: number },
  depthMm: number,
): [Point, Point, Point, Point] | null => {
  const h = computeHomography(
    [{x:0,y:0},{x:plane.widthMm,y:0},{x:plane.widthMm,y:plane.heightMm},{x:0,y:plane.heightMm}],
    plane.corners,
  );
  const cx = camera.principalPoint?.x ?? imageSize.width / 2;
  const cy = camera.principalPoint?.y ?? imageSize.height / 2;
  const fx = camera.focalLengthPx ?? imageSize.width / (2 * Math.tan((camera.fieldOfViewDeg || 60) * Math.PI / 360));
  const fy = fx;
  const q1 = multiplyKInverse([h[0], h[3], h[6]], fx, fy, cx, cy);
  const q2 = multiplyKInverse([h[1], h[4], h[7]], fx, fy, cx, cy);
  const q3 = multiplyKInverse([h[2], h[5], h[8]], fx, fy, cx, cy);
  const scale = 2 / Math.max(1e-9, norm(q1) + norm(q2));
  const r1 = q1.map(v => v * scale);
  const r2raw = q2.map(v => v * scale);
  const dot = r1[0]*r2raw[0] + r1[1]*r2raw[1] + r1[2]*r2raw[2];
  const r2n = r2raw.map((v, i) => v - dot * r1[i]);
  const r2scale = Math.max(1e-9, norm(r2n));
  const r2 = r2n.map(v => v / r2scale);
  const r3 = cross(r1, r2);
  const t = q3.map(v => v * scale);
  const inverse = computeHomography(plane.corners, [{x:0,y:0},{x:plane.widthMm,y:0},{x:plane.widthMm,y:plane.heightMm},{x:0,y:plane.heightMm}]);
  const projected = corners.map(corner => {
    const world = transform(corner, inverse);
    if (!world) return null;
    // Negative Z moves away from the calibrated surface toward the camera-facing side.
    const z = -Math.max(0, depthMm);
    const xc = r1[0]*world.x + r2[0]*world.y + r3[0]*z + t[0];
    const yc = r1[1]*world.x + r2[1]*world.y + r3[1]*z + t[1];
    const zc = r1[2]*world.x + r2[2]*world.y + r3[2]*z + t[2];
    if (zc <= 1e-6) return null;
    return { x: fx * xc / zc + cx, y: fy * yc / zc + cy };
  });
  return projected.some(p => !p) ? null : projected as [Point, Point, Point, Point];
};

export const distortedSourcePoint = (point: Point, size: {width:number;height:number}, k1: number, k2: number): Point => {
  const cx = size.width / 2, cy = size.height / 2;
  const scale = Math.max(size.width, size.height) / 2;
  const x = (point.x - cx) / scale, y = (point.y - cy) / scale;
  const r2 = x*x + y*y;
  const radial = 1 + k1*r2 + k2*r2*r2;
  return { x: cx + x*radial*scale, y: cy + y*radial*scale };
};
