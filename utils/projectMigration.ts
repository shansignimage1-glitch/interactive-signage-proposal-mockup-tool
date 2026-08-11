import { MockupState } from '../types';

/** Normalizes projects saved by older app versions before they enter React state. */
export const normalizeProjectState = (input: MockupState): MockupState => {
  const canvases = Array.isArray(input.canvases) ? input.canvases.map(canvas => {
    const legacyPlane = canvas.calibration?.plane;
    const planes = canvas.calibration?.planes?.length
      ? canvas.calibration.planes
      : legacyPlane ? [{ id: 'legacy-plane', name: 'Wall 1', ...legacyPlane }] : [];
    const activePlaneId = canvas.calibration?.activePlaneId ?? planes[0]?.id;
    const activePlane = planes.find(plane => plane.id === activePlaneId) ?? planes[0];
    return ({
    ...canvas,
    signs: Array.isArray(canvas.signs) ? canvas.signs.map(sign => ({
      ...sign,
      placementAnchor: sign.placementAnchor ?? 'center',
      projectionMode: sign.projectionMode ?? 'planar',
      physicalDepthMm: sign.physicalDepthMm ?? 100,
      calibrationPlaneId: sign.calibrationPlaneId ?? activePlaneId,
    })) : [],
    dimensions: Array.isArray(canvas.dimensions) ? canvas.dimensions : [],
    activeSignId: canvas.activeSignId ?? null,
    activeDimensionId: canvas.activeDimensionId ?? null,
    calibration: canvas.calibration ? {
      ...canvas.calibration,
      planes,
      activePlaneId,
      plane: activePlane ? { corners: activePlane.corners, widthMm: activePlane.widthMm, heightMm: activePlane.heightMm } : canvas.calibration.plane,
    } : null,
    placement: canvas.placement ?? {
      snapEnabled: true,
      showVanishingGuides: false,
      lens: { enabled: false, k1: 0, k2: 0 },
      camera: { enabled: false, fieldOfViewDeg: 60, estimated: true },
    },
  });
  }) : [];

  return {
    ...input,
    canvases,
    activeCanvasId: canvases.some(canvas => canvas.id === input.activeCanvasId)
      ? input.activeCanvasId
      : (canvases[0]?.id ?? ''),
    unitSystem: input.unitSystem ?? 'metric',
    savedTemplates: Array.isArray(input.savedTemplates) ? input.savedTemplates : [],
    referenceImages: Array.isArray(input.referenceImages) ? input.referenceImages : [],
    notes: input.notes ?? '',
    showDimensions: input.showDimensions ?? true,
    cloudRevision: input.cloudRevision ?? 0,
    isNightMode: input.isNightMode ?? false,
    isOnline: input.isOnline ?? navigator.onLine,
    isSyncing: false,
  };
};
