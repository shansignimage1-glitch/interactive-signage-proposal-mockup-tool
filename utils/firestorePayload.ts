import type { MockupState, Point } from '../types';

type StoredContour = { points: Point[] };

/**
 * Firestore rejects arrays that directly contain other arrays. Sign element
 * contours are Point[][] in the editor, so wrap each contour in a small map
 * while the project is in Firestore and restore it on load.
 */
export const encodeProjectForFirestore = (state: MockupState): Record<string, unknown> => ({
  ...state,
  canvases: state.canvases.map(canvas => ({
    ...canvas,
    signs: canvas.signs.map(sign => ({
      ...sign,
      elements: sign.elements?.map(element => ({
        ...element,
        contours: element.contours.map(points => ({ points } satisfies StoredContour)),
      })),
    })),
  })),
});

export const decodeProjectFromFirestore = (value: unknown): MockupState => {
  const state = value as MockupState;
  return {
    ...state,
    canvases: Array.isArray(state.canvases) ? state.canvases.map(canvas => ({
      ...canvas,
      signs: Array.isArray(canvas.signs) ? canvas.signs.map(sign => ({
        ...sign,
        elements: Array.isArray(sign.elements) ? sign.elements.map(element => ({
          ...element,
          contours: Array.isArray(element.contours)
            ? (element.contours as unknown[]).map(contour =>
                Array.isArray(contour) ? contour as Point[] : (contour as StoredContour)?.points ?? [])
            : [],
        })) : undefined,
      })) : [],
    })) : [],
  };
};

/** Firestore rejects undefined at any nesting level, while local IndexedDB does not. */
export const withoutUndefined = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.filter(item => item !== undefined).map(item => withoutUndefined(item)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)]),
    ) as T;
  }
  return value;
};
