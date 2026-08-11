import { describe, expect, it } from 'vitest';
import { createDefaultBuildingModel, normalizeBuildingModel } from '../../utils/buildingModel';
import { makeProject } from '../fixtures/project';

describe('building proposal model', () => {
  it('maps available views to faces without inventing missing elevations', () => {
    const project = makeProject();
    project.canvases[0].backgroundImage = 'data:image/png;base64,abc';
    const model = createDefaultBuildingModel(project.canvases);

    expect(model.faceAssignments.front.canvasId).toBe(project.canvases[0].id);
    expect(model.faceAssignments.front.coverage).toBe('estimated');
    expect(model.faceAssignments.right).toEqual({ canvasId: null, coverage: 'unsurveyed' });
    expect(model.faceAssignments.rear).toEqual({ canvasId: null, coverage: 'unsurveyed' });
    expect(model.faceAssignments.left).toEqual({ canvasId: null, coverage: 'unsurveyed' });
  });

  it('removes deleted elevation references and preserves valid massing dimensions', () => {
    const project = makeProject();
    const normalized = normalizeBuildingModel({
      widthMm: 18000,
      depthMm: 9000,
      heightMm: 7200,
      faceAssignments: {
        front: { canvasId: 'deleted', coverage: 'measured' },
        right: { canvasId: null, coverage: 'unsurveyed' },
        rear: { canvasId: null, coverage: 'unsurveyed' },
        left: { canvasId: null, coverage: 'unsurveyed' },
      },
    }, project.canvases);

    expect(normalized.widthMm).toBe(18000);
    expect(normalized.depthMm).toBe(9000);
    expect(normalized.heightMm).toBe(7200);
    expect(normalized.faceAssignments.front).toEqual({ canvasId: null, coverage: 'unsurveyed' });
  });
});

