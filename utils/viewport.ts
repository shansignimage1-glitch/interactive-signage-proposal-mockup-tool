import type { Point, Size } from '../types';

export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

export const MIN_VIEW_SCALE = 0.25;
export const MAX_VIEW_SCALE = 8;

export const clampViewScale = (scale: number): number =>
  Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, scale));

/**
 * Zoom while keeping the same content coordinate beneath a screen point.
 * View x/y are screen-pixel offsets from the viewport centre; content uses
 * intrinsic image coordinates.
 */
export const zoomViewAtPoint = (
  view: ViewTransform,
  nextScale: number,
  screenPoint: Point,
  viewport: Size,
  content: Size,
  baseScale: number,
): ViewTransform => {
  const scale = clampViewScale(nextScale);
  if (!Number.isFinite(baseScale) || baseScale <= 0 || view.scale <= 0) {
    return { ...view, scale };
  }

  const viewportCenter = { x: viewport.width / 2, y: viewport.height / 2 };
  const contentCenter = { x: content.width / 2, y: content.height / 2 };
  const anchor = {
    x: (screenPoint.x - viewportCenter.x - view.x) / (baseScale * view.scale) + contentCenter.x,
    y: (screenPoint.y - viewportCenter.y - view.y) / (baseScale * view.scale) + contentCenter.y,
  };

  return {
    scale,
    x: screenPoint.x - viewportCenter.x - (anchor.x - contentCenter.x) * baseScale * scale,
    y: screenPoint.y - viewportCenter.y - (anchor.y - contentCenter.y) * baseScale * scale,
  };
};

/** Pinch-zoom from a fixed starting view, including movement of the centroid. */
export const viewForPinch = (
  startView: ViewTransform,
  startCentroid: Point,
  currentCentroid: Point,
  startDistance: number,
  currentDistance: number,
  viewport: Size,
  content: Size,
  baseScale: number,
): ViewTransform => {
  const safeStartDistance = Math.max(1, startDistance);
  const scale = clampViewScale(startView.scale * (currentDistance / safeStartDistance));
  const anchored = zoomViewAtPoint(
    startView,
    scale,
    startCentroid,
    viewport,
    content,
    baseScale,
  );

  return {
    ...anchored,
    x: anchored.x + currentCentroid.x - startCentroid.x,
    y: anchored.y + currentCentroid.y - startCentroid.y,
  };
};
