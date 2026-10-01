import type { Canvas, Point, SiteCapturePhoto } from '../types';

// "Measure sharp, store lean": a view's photo can carry more resolution than
// the project keeps long-term. While measuring, the precision loupe shows the
// full-resolution original; "Finish measuring" then drops it and keeps a
// working copy no larger than LEAN_MAX_DIMENSION.
export const LEAN_MAX_DIMENSION = 4096;

export type FinishMeasuringInfo =
    /** Promoted phone site photo whose full-resolution original is still linked. */
    | { kind: 'capture-original'; capture: SiteCapturePhoto; originalRef: string; width: number; height: number }
    /** Uploaded background still in its full-resolution coordinate space. */
    | { kind: 'oversized-background'; width: number; height: number };

/** The linked site capture whose working image is this view's background. */
export const linkedSiteCapture = (canvas: Canvas, captures: SiteCapturePhoto[] | undefined): SiteCapturePhoto | null =>
    (canvas.siteCaptureLink
        && captures?.find(capture => capture.id === canvas.siteCaptureLink!.captureId && capture.promotedCanvasId === canvas.id))
    || null;

/** What "Finish measuring" would release for this view, or null when the view is already lean. */
export const getFinishMeasuringInfo = (canvas: Canvas, captures: SiteCapturePhoto[] | undefined): FinishMeasuringInfo | null => {
    const capture = linkedSiteCapture(canvas, captures);
    if (capture?.originalRef) {
        return { kind: 'capture-original', capture, originalRef: capture.originalRef, width: capture.pixelWidth, height: capture.pixelHeight };
    }
    const { width, height } = canvas.backgroundSize;
    // One pixel of slack: rounding during an earlier downscale must not re-offer the step.
    if (Math.max(width, height) > LEAN_MAX_DIMENSION + 1) return { kind: 'oversized-background', width, height };
    return null;
};

/** Target size for keeping an image within LEAN_MAX_DIMENSION, preserving aspect. */
export const leanSize = (width: number, height: number): { width: number; height: number } => {
    const scale = Math.min(1, LEAN_MAX_DIMENSION / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

/**
 * Map every image-space coordinate of a view into a resized copy of its photo.
 * Real-world values (millimetres, units, plane mm corners) and screen-space
 * values (annotation stroke widths, relative extrusion depths) are left alone,
 * as are lens coefficients, which are normalised to the image size. Because
 * calibration points move with everything else, every measurement keeps its
 * real-world value exactly.
 */
export const scaleCanvasGeometry = (canvas: Canvas, sx: number, sy: number): Canvas => {
    const p = (point: Point): Point => ({ x: point.x * sx, y: point.y * sy });
    const quad = (corners: [Point, Point, Point, Point]) => corners.map(p) as [Point, Point, Point, Point];
    const calibration = canvas.calibration
        ? {
            ...canvas.calibration,
            start: p(canvas.calibration.start),
            end: p(canvas.calibration.end),
            plane: canvas.calibration.plane ? { ...canvas.calibration.plane, corners: quad(canvas.calibration.plane.corners) } : undefined,
            planes: canvas.calibration.planes?.map(plane => ({ ...plane, corners: quad(plane.corners) })),
        }
        : canvas.calibration;
    const camera = canvas.placement?.camera;
    return {
        ...canvas,
        signs: canvas.signs.map(sign => ({ ...sign, corners: quad(sign.corners) })),
        dimensions: canvas.dimensions.map(dimension => ({ ...dimension, start: p(dimension.start), end: p(dimension.end) })),
        annotations: canvas.annotations?.map(annotation => ({ ...annotation, points: annotation.points.map(p) })),
        calibration,
        placement: canvas.placement && camera
            ? {
                ...canvas.placement,
                camera: {
                    ...camera,
                    principalPoint: camera.principalPoint ? p(camera.principalPoint) : undefined,
                    focalLengthPx: camera.focalLengthPx !== undefined ? camera.focalLengthPx * sx : undefined,
                },
            }
            : canvas.placement,
    };
};
