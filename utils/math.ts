import { Point } from '../types';

// Helper to compute the distance between two points
export const distance = (p1: Point, p2: Point) => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

// Check if a point is inside a polygon (Ray casting algorithm)
export function isPointInPolygon(point: Point, vs: Point[]): boolean {
  const x = point.x, y = point.y;
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x, yi = vs[i].y;
    const xj = vs[j].x, yj = vs[j].y;
    
    const intersect = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Computes a 3x3 Homography Matrix mapping source quad (0,0 -> 1,1) to destination quad (corners)
// This is used for perspective correct texture mapping in the shader (or pre-calc)
export function computeHomography(
  src: [Point, Point, Point, Point],
  dst: [Point, Point, Point, Point]
): number[] {
  let a = [];
  let b = [];

  for (let i = 0; i < 4; i++) {
    let x = src[i].x;
    let y = src[i].y;
    let X = dst[i].x;
    let Y = dst[i].y;
    a.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    a.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(X);
    b.push(Y);
  }

  // Gaussian elimination to solve Ax = b
  const x = solveGaussian(a, b);
  
  // Return standard 3x3 matrix (row-major for WebGL usually, but we'll adapt)
  // [h0, h1, h2, h3, h4, h5, h6, h7, 1]
  return [x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 1];
}

function solveGaussian(A: number[][], b: number[]): number[] {
  const n = A.length;
  for (let i = 0; i < n; i++) {
    let maxEl = Math.abs(A[i][i]);
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(A[k][i]) > maxEl) {
        maxEl = Math.abs(A[k][i]);
        maxRow = k;
      }
    }

    for (let k = i; k < n; k++) {
      const tmp = A[maxRow][k];
      A[maxRow][k] = A[i][k];
      A[i][k] = tmp;
    }
    const tmp = b[maxRow];
    b[maxRow] = b[i];
    b[i] = tmp;

    for (let k = i + 1; k < n; k++) {
      const c = -A[k][i] / A[i][i];
      for (let j = i; j < n; j++) {
        if (i === j) {
          A[k][j] = 0;
        } else {
          A[k][j] += c * A[i][j];
        }
      }
      b[k] += c * b[i];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i > -1; i--) {
    let sum = 0;
    for (let j = i + 1; j < n; j++) {
      sum += A[i][j] * x[j];
    }
    x[i] = (b[i] - sum) / A[i][i];
  }
  return x;
}

// Convert hex color to normalized RGB array [r, g, b]
export function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255,
      ]
    : [0, 0, 0];
}