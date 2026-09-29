import type { MockupState } from '../types';

// Fields that describe the live session or the viewer's current navigation,
// not the user's editable project content. Changing them is not an "edit"
// that undo should revert.
const SESSION_AND_NAVIGATION_FIELDS = new Set<string>([
    'user', 'isOnline', 'isSyncing', 'lastSaved', 'cloudRevision',
    'activeCanvasId',
]);
const CANVAS_SELECTION_FIELDS = new Set<string>(['activeSignId', 'activeDimensionId']);

const shallowEqualExcept = (a: object, b: object, ignored: Set<string>): boolean => {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (!ignored.has(key) && left[key] !== right[key]) return false;
    }
    return true;
};

/**
 * True when two states hold the same editable project content. State updates
 * are immutable, so unchanged content keeps its object identity and a shallow
 * reference comparison is exact. Session/sync fields and selection are ignored.
 */
export const hasSameEditableContent = (a: MockupState, b: MockupState): boolean => {
    if (a === b) return true;
    if (!shallowEqualExcept(a, b, new Set([...SESSION_AND_NAVIGATION_FIELDS, 'canvases']))) return false;
    if (a.canvases === b.canvases) return true;
    if (a.canvases.length !== b.canvases.length) return false;
    return a.canvases.every((canvas, index) =>
        shallowEqualExcept(canvas, b.canvases[index], CANVAS_SELECTION_FIELDS));
};
