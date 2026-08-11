import { BuildingFaceId, BuildingModelSettings, Canvas } from '../types';
import { getActiveCalibrationPlane } from './cameraGeometry';

export const BUILDING_FACE_IDS: BuildingFaceId[] = ['front', 'right', 'rear', 'left'];

const coverageForCanvas = (canvas: Canvas | undefined) => {
  if (!canvas?.backgroundImage) return 'unsurveyed' as const;
  return getActiveCalibrationPlane(canvas.calibration ?? null) ? 'measured' as const : 'estimated' as const;
};

export const createDefaultBuildingModel = (canvases: Canvas[]): BuildingModelSettings => {
  const firstPlane = getActiveCalibrationPlane(canvases[0]?.calibration ?? null);
  const widthMm = firstPlane?.widthMm ?? 12000;
  const heightMm = firstPlane?.heightMm ?? 6000;
  return {
    widthMm,
    depthMm: Math.max(6000, Math.round(widthMm * 0.7)),
    heightMm,
    faceAssignments: Object.fromEntries(BUILDING_FACE_IDS.map((face, index) => {
      const canvas = canvases[index];
      return [face, { canvasId: canvas?.id ?? null, coverage: coverageForCanvas(canvas) }];
    })) as BuildingModelSettings['faceAssignments'],
  };
};

export const normalizeBuildingModel = (
  settings: BuildingModelSettings | undefined,
  canvases: Canvas[],
): BuildingModelSettings => {
  const defaults = createDefaultBuildingModel(canvases);
  if (!settings) return defaults;
  const validCanvasIds = new Set(canvases.map(canvas => canvas.id));
  return {
    widthMm: settings.widthMm > 0 ? settings.widthMm : defaults.widthMm,
    depthMm: settings.depthMm > 0 ? settings.depthMm : defaults.depthMm,
    heightMm: settings.heightMm > 0 ? settings.heightMm : defaults.heightMm,
    faceAssignments: Object.fromEntries(BUILDING_FACE_IDS.map(face => {
      const requestedId = settings.faceAssignments?.[face]?.canvasId;
      const canvasId = requestedId && validCanvasIds.has(requestedId) ? requestedId : null;
      const canvas = canvases.find(item => item.id === canvasId);
      return [face, { canvasId, coverage: coverageForCanvas(canvas) }];
    })) as BuildingModelSettings['faceAssignments'],
  };
};

