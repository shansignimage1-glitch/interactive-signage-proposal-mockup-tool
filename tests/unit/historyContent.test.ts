import { describe, expect, it } from 'vitest';
import { hasSameEditableContent } from '../../utils/historyContent';
import { makeProject } from '../fixtures/project';

describe('hasSameEditableContent (undo bookkeeping)', () => {
  it('ignores sync/session fields so saving never looks like an edit', () => {
    const recorded = makeProject();
    const afterSave = { ...recorded, cloudRevision: 7, lastSaved: recorded.lastSaved + 1, isSyncing: true, isOnline: false };
    expect(hasSameEditableContent(afterSave, recorded)).toBe(true);
  });

  it('ignores selection and view navigation', () => {
    const recorded = makeProject();
    const selected = {
      ...recorded,
      activeCanvasId: 'other-view',
      canvases: recorded.canvases.map(canvas => ({ ...canvas, activeSignId: 'sign-9', activeDimensionId: 'dim-3' })),
    };
    expect(hasSameEditableContent(selected, recorded)).toBe(true);
  });

  it('detects an untracked canvas edit such as a dimension drag', () => {
    const recorded = makeProject();
    const dragged = {
      ...recorded,
      canvases: recorded.canvases.map(canvas => ({
        ...canvas,
        dimensions: [{ id: 'd', variant: 'linear' as const, type: 'horizontal' as const, start: { x: 0, y: 0 }, end: { x: 5, y: 0 }, text: '', color: '#fff' }],
      })),
    };
    expect(hasSameEditableContent(dragged, recorded)).toBe(false);
  });

  it('detects project-level edits', () => {
    const recorded = makeProject();
    expect(hasSameEditableContent({ ...recorded, notes: 'changed' }, recorded)).toBe(false);
    expect(hasSameEditableContent({ ...recorded, canvases: [...recorded.canvases, recorded.canvases[0]] }, recorded)).toBe(false);
  });
});
