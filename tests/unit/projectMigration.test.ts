import { describe, expect, it, vi } from 'vitest';
import { normalizeProjectState } from '../../utils/projectMigration';
import { makeProject } from '../fixtures/project';

describe('project migration and normalization', () => {
  it('fills fields introduced after older projects were saved', () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    const legacy = makeProject() as any;
    delete legacy.unitSystem;
    delete legacy.savedTemplates;
    delete legacy.referenceImages;
    delete legacy.notes;
    delete legacy.canvases[0].calibration;
    delete legacy.canvases[0].dimensions;
    legacy.isSyncing = true;

    const normalized = normalizeProjectState(legacy);
    expect(normalized.unitSystem).toBe('metric');
    expect(normalized.savedTemplates).toEqual([]);
    expect(normalized.referenceImages).toEqual([]);
    expect(normalized.canvases[0].calibration).toBeNull();
    expect(normalized.canvases[0].dimensions).toEqual([]);
    expect(normalized.buildingModel?.faceAssignments.front.canvasId).toBe('canvas-1');
    expect(normalized.buildingModel?.faceAssignments.right.coverage).toBe('unsurveyed');
    expect(normalized.isSyncing).toBe(false);
  });

  it('repairs an invalid active canvas while preserving existing values', () => {
    const state = makeProject({ activeCanvasId: 'deleted', unitSystem: 'imperial' });
    const normalized = normalizeProjectState(state);
    expect(normalized.activeCanvasId).toBe('canvas-1');
    expect(normalized.unitSystem).toBe('imperial');
    expect(normalized).not.toBe(state);
  });

  it('migrates legacy auto-detected extrusion to a stable sign-relative depth once', () => {
    const legacy = makeProject() as any;
    legacy.canvases[0].signs = [{
      id: 'legacy-sign',
      name: 'Legacy artwork',
      image: 'data:image/png;base64,AA==',
      corners: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 150 }, { x: 0, y: 150 }],
      signType: 'fascia_non_ill',
      extrusionEnabled: true,
      extrusionDepth: 15,
      extrusionAngle: 45,
      opacity: 1,
      blendMode: 'normal',
      sideColor: '#111111',
      elementsSourceSize: { width: 1200, height: 600 },
      elements: [
        { id: 'auto-0-0-0', name: 'Shallow', contours: [], depth: 10, enabled: true },
        { id: 'auto-1-10-0', name: 'Deep', contours: [], depth: 30, enabled: true },
      ],
    }];

    const normalized = normalizeProjectState(legacy);
    const sign = normalized.canvases[0].signs[0];
    expect(sign.elementDepthModel).toBe('relative-width-v1');
    expect(sign.elements?.map(element => element.depth)).toEqual([20, 60]);

    const normalizedAgain = normalizeProjectState(normalized);
    expect(normalizedAgain.canvases[0].signs[0].elements?.map(element => element.depth)).toEqual([20, 60]);
  });
});
