import { Point, Size } from '../types';

// Classical-CV element isolation for flat sign artwork.
//
// Pipeline: image → capped offscreen canvas → background estimation →
// binarize → connected components → boundary trace → simplify → contours
// in full-resolution sign-image px space.
//
// Everything is pure and framework-free. The ElementDetector interface exists
// so an ONNX-based detector (PiDiNet / U2NETP via onnxruntime-web) can slot in
// later for photographed signs — its edge map would feed the same
// components→contours pipeline below.

export interface DetectionOptions {
  sensitivity: number; // 0..1 — higher finds more/fainter elements
  minAreaPct: number;  // 0..5 — components smaller than this % of image are noise
}

export interface DetectedElement {
  contours: Point[][];                       // full-res sign-image px
  bbox: { x: number; y: number; w: number; h: number };
  areaPx: number;                            // full-res px²
}

export interface ElementDetector {
  detect(imageUrl: string, opts: DetectionOptions): Promise<DetectedElement[]>;
}

const DETECT_MAX_DIM = 1024;
const MAX_CONTOUR_POINTS = 200;

// --- Image loading ---

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load sign image for detection'));
    img.src = url;
  });

// --- Binarization ---

// Foreground mask: 1 = element pixel, 0 = background.
const binarize = (data: ImageData, sensitivity: number): Uint8Array => {
  const { width: w, height: h, data: px } = data;
  const n = w * h;
  const mask = new Uint8Array(n);

  // Alpha mode: if a meaningful share of pixels are transparent, alpha IS the mask
  let transparent = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) transparent++;
  if (transparent > n * 0.02) {
    for (let i = 0; i < n; i++) mask[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
    return mask;
  }

  // Opaque artwork: background color estimated from the border ring
  let br = 0, bg = 0, bb = 0, count = 0;
  const sampleRow = (y: number) => {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      br += px[i]; bg += px[i + 1]; bb += px[i + 2]; count++;
    }
  };
  const sampleCol = (x: number) => {
    for (let y = 1; y < h - 1; y++) {
      const i = (y * w + x) * 4;
      br += px[i]; bg += px[i + 1]; bb += px[i + 2]; count++;
    }
  };
  sampleRow(0); sampleRow(h - 1); sampleCol(0); sampleCol(w - 1);
  br /= count; bg /= count; bb /= count;

  // sensitivity 1 → small distance counts as foreground; 0 → only strong contrast
  const threshold = 30 + (1 - sensitivity) * 120;
  const t2 = threshold * threshold;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const dr = px[j] - br, dg = px[j + 1] - bg, db = px[j + 2] - bb;
    mask[i] = (dr * dr + dg * dg + db * db) > t2 ? 1 : 0;
  }
  return mask;
};

// --- Connected components (BFS flood fill, 4-connectivity) ---

interface Component {
  label: number;
  area: number;
  minX: number; minY: number; maxX: number; maxY: number;
}

const labelComponents = (mask: Uint8Array, w: number, h: number): { labels: Int32Array; components: Component[] } => {
  const labels = new Int32Array(w * h); // 0 = unlabeled/background
  const components: Component[] = [];
  const queue = new Int32Array(w * h);
  let nextLabel = 1;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || labels[start] !== 0) continue;

    const label = nextLabel++;
    const comp: Component = { label, area: 0, minX: w, minY: h, maxX: 0, maxY: 0 };
    let qHead = 0, qTail = 0;
    queue[qTail++] = start;
    labels[start] = label;

    while (qHead < qTail) {
      const idx = queue[qHead++];
      const x = idx % w, y = (idx / w) | 0;
      comp.area++;
      if (x < comp.minX) comp.minX = x;
      if (x > comp.maxX) comp.maxX = x;
      if (y < comp.minY) comp.minY = y;
      if (y > comp.maxY) comp.maxY = y;

      if (x > 0 && mask[idx - 1] === 1 && labels[idx - 1] === 0) { labels[idx - 1] = label; queue[qTail++] = idx - 1; }
      if (x < w - 1 && mask[idx + 1] === 1 && labels[idx + 1] === 0) { labels[idx + 1] = label; queue[qTail++] = idx + 1; }
      if (y > 0 && mask[idx - w] === 1 && labels[idx - w] === 0) { labels[idx - w] = label; queue[qTail++] = idx - w; }
      if (y < h - 1 && mask[idx + w] === 1 && labels[idx + w] === 0) { labels[idx + w] = label; queue[qTail++] = idx + w; }
    }
    components.push(comp);
  }
  return { labels, components };
};

// --- Boundary tracing (Moore neighborhood, clockwise) ---

// Moore neighbor offsets, clockwise starting from W
const MOORE = [
  [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1],
];

const traceBoundary = (labels: Int32Array, w: number, h: number, comp: Component): Point[] => {
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === comp.label;

  // Start: first component pixel in scan order within the bbox
  let sx = -1, sy = -1;
  outer: for (let y = comp.minY; y <= comp.maxY; y++) {
    for (let x = comp.minX; x <= comp.maxX; x++) {
      if (inside(x, y)) { sx = x; sy = y; break outer; }
    }
  }
  if (sx < 0) return [];
  if (comp.area === 1) return [{ x: sx, y: sy }];

  const contour: Point[] = [];
  let cx = sx, cy = sy;
  // Scan order guarantees the W neighbor is background, so treat the walk as
  // having ARRIVED moving East (index 4 in MOORE). Each search then starts at
  // (dir + 5) % 8 — the neighbor immediately after the backtrack direction —
  // which keeps the walk hugging the boundary instead of cutting into the
  // interior (an off-by-one here closes degenerate 4px loops).
  let dir = 4;
  const maxSteps = comp.area * 4 + 16;

  for (let step = 0; step < maxSteps; step++) {
    contour.push({ x: cx, y: cy });
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 5 + k) % 8;
      const nx = cx + MOORE[d][0], ny = cy + MOORE[d][1];
      if (inside(nx, ny)) {
        cx = nx; cy = ny; dir = d;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated pixel (shouldn't happen for area > 1)
    if (cx === sx && cy === sy) break; // closed the loop
  }
  return contour;
};

// --- Ramer-Douglas-Peucker simplification ---

const perpendicularDist = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
};

const rdp = (points: Point[], epsilon: number): Point[] => {
  if (points.length < 3) return points;
  let maxDist = 0, maxIdx = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDist(points[i], a, b);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist <= epsilon) return [a, b];
  const left = rdp(points.slice(0, maxIdx + 1), epsilon);
  const right = rdp(points.slice(maxIdx), epsilon);
  return [...left.slice(0, -1), ...right];
};

// Closed-ring simplification: plain RDP anchors on the first/last points, and
// for a closed boundary those are adjacent pixels — a degenerate chord that can
// collapse straight-edged shapes to 2 points. Split the ring at the point
// farthest from the start and simplify the two halves independently.
const simplifyClosed = (points: Point[], epsilon: number): Point[] => {
  if (points.length < 4) return points;
  let farIdx = 1, farDist = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
    if (d > farDist) { farDist = d; farIdx = i; }
  }
  const half1 = rdp(points.slice(0, farIdx + 1), epsilon);
  const half2 = rdp([...points.slice(farIdx), points[0]], epsilon);
  return [...half1.slice(0, -1), ...half2.slice(0, -1)];
};

const simplifyContour = (points: Point[]): Point[] => {
  let epsilon = 1.2;
  let result = simplifyClosed(points, epsilon);
  while (result.length > MAX_CONTOUR_POINTS && epsilon < 24) {
    epsilon *= 1.6;
    result = simplifyClosed(points, epsilon);
  }
  return result;
};

const traceHoles = (labels: Int32Array, w: number, h: number, outer: Component): Point[][] => {
  const inverse = new Uint8Array(w * h);
  for (let y = outer.minY; y <= outer.maxY; y++) for (let x = outer.minX; x <= outer.maxX; x++) {
    if (labels[y * w + x] !== outer.label) inverse[y * w + x] = 1;
  }
  const holes = labelComponents(inverse, w, h);
  return holes.components
    .filter(c => c.minX > outer.minX && c.maxX < outer.maxX && c.minY > outer.minY && c.maxY < outer.maxY)
    .map(c => {
      const raw = traceBoundary(holes.labels, w, h, c);
      const simplified = simplifyContour(raw);
      // Tiny counters (for example a small lowercase 'a') can legitimately
      // collapse below three vertices at the normal RDP tolerance. Preserve
      // their unsimplified ring rather than filling the letter solid.
      return simplified.length >= 3 ? simplified : raw;
    })
    .filter(contour => contour.length >= 3);
};

// Pure algorithm hooks used by regression tests. Keeping these grouped avoids
// making implementation details look like the main public detector API.
export const elementDetectionTestables = {
  binarize,
  labelComponents,
  traceBoundary,
  simplifyClosed,
  traceHoles,
};

// --- Public API ---

export const classicalDetector: ElementDetector = {
  detect: async (imageUrl, opts) => {
    const img = await loadImage(imageUrl);
    const fullW = img.naturalWidth, fullH = img.naturalHeight;
    if (!fullW || !fullH) return [];

    const scale = Math.min(1, DETECT_MAX_DIM / Math.max(fullW, fullH));
    const w = Math.max(1, Math.round(fullW * scale));
    const h = Math.max(1, Math.round(fullH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(img, 0, 0, w, h);

    const mask = binarize(ctx.getImageData(0, 0, w, h), opts.sensitivity);
    const { labels, components } = labelComponents(mask, w, h);

    const minArea = (opts.minAreaPct / 100) * w * h;
    const toFull = 1 / scale;

    return components
      .filter(c => c.area >= Math.max(4, minArea))
      .sort((a, b) => b.area - a.area)
      .slice(0, 64) // hard cap — beyond this the artwork needs a higher min-size, not more elements
      .map(c => {
        const raw = traceBoundary(labels, w, h, c);
        const simplified = simplifyContour(raw).map(p => ({ x: p.x * toFull, y: p.y * toFull }));
        const holes = traceHoles(labels, w, h, c).map(contour => contour.map(p => ({ x: p.x * toFull, y: p.y * toFull })));
        return {
          contours: [simplified, ...holes],
          bbox: { x: c.minX * toFull, y: c.minY * toFull, w: (c.maxX - c.minX + 1) * toFull, h: (c.maxY - c.minY + 1) * toFull },
          areaPx: c.area * toFull * toFull,
        };
      })
      .filter(e => e.contours[0].length >= 3);
  },
};

// Fills an element's contours white on transparent — used for the WebGL face
// mask texture and for click hit-testing in the Element Studio.
export const buildElementMask = (contours: Point[][], imageSize: Size, maxDim = 1024): HTMLCanvasElement => {
  const scale = Math.min(1, maxDim / Math.max(imageSize.width, imageSize.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(imageSize.width * scale));
  canvas.height = Math.max(1, Math.round(imageSize.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  contours.forEach(contour => {
    contour.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x * scale, p.y * scale);
      else ctx.lineTo(p.x * scale, p.y * scale);
    });
    ctx.closePath();
  });
  ctx.fill('evenodd');
  return canvas;
};
