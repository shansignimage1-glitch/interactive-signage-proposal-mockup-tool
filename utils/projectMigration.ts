import { MockupState } from '../types';

/** Normalizes projects saved by older app versions before they enter React state. */
export const normalizeProjectState = (input: MockupState): MockupState => {
  const canvases = Array.isArray(input.canvases) ? input.canvases.map(canvas => ({
    ...canvas,
    signs: Array.isArray(canvas.signs) ? canvas.signs : [],
    dimensions: Array.isArray(canvas.dimensions) ? canvas.dimensions : [],
    activeSignId: canvas.activeSignId ?? null,
    activeDimensionId: canvas.activeDimensionId ?? null,
    calibration: canvas.calibration ?? null,
  })) : [];

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
