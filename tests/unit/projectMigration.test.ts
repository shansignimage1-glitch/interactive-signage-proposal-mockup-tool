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
    expect(normalized.isSyncing).toBe(false);
  });

  it('repairs an invalid active canvas while preserving existing values', () => {
    const state = makeProject({ activeCanvasId: 'deleted', unitSystem: 'imperial' });
    const normalized = normalizeProjectState(state);
    expect(normalized.activeCanvasId).toBe('canvas-1');
    expect(normalized.unitSystem).toBe('imperial');
    expect(normalized).not.toBe(state);
  });
});
