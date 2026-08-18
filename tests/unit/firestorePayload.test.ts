import { describe, expect, it } from 'vitest';
import { decodeProjectFromFirestore, encodeProjectForFirestore, withoutUndefined } from '../../utils/firestorePayload';
import { makeProject } from '../fixtures/project';

describe('Firestore project payloads', () => {
  it('removes undefined optional phone-capture fields at every nesting level', () => {
    const payload = {
      projectName: 'Xplore aviation',
      siteCaptures: [{
        location: undefined,
        referenceWall: { widthMm: undefined, heightMm: 3200, planeDepthMm: undefined },
        supportingPhotos: [undefined, { id: 'detail', address: undefined }],
      }],
    };

    expect(withoutUndefined(payload)).toEqual({
      projectName: 'Xplore aviation',
      siteCaptures: [{
        referenceWall: { heightMm: 3200 },
        supportingPhotos: [{ id: 'detail' }],
      }],
    });
  });

  it('round-trips sign contours without nested arrays', () => {
    const project = makeProject();
    project.canvases[0].signs = [{
      id: 'sign-1', name: 'Letters', image: '',
      corners: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      signType: 'channel_face', extrusionEnabled: true, extrusionDepth: 15,
      extrusionAngle: 45, opacity: 1, blendMode: 'normal', sideColor: '#000000',
      elements: [{
        id: 'letter-a', name: 'A', enabled: true, depth: 12,
        contours: [[{ x: 1, y: 2 }, { x: 3, y: 4 }], [{ x: 5, y: 6 }]],
      }],
    }];

    const encoded = encodeProjectForFirestore(project) as any;
    expect(encoded.canvases[0].signs[0].elements[0].contours).toEqual([
      { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
      { points: [{ x: 5, y: 6 }] },
    ]);

    const hasNestedArray = (value: unknown, parentIsArray = false): boolean =>
      Array.isArray(value)
        ? parentIsArray || value.some(item => hasNestedArray(item, true))
        : Boolean(value && typeof value === 'object'
            && Object.values(value as Record<string, unknown>).some(item => hasNestedArray(item, false)));
    expect(hasNestedArray(encoded)).toBe(false);
    expect(decodeProjectFromFirestore(encoded).canvases[0].signs[0].elements?.[0].contours)
      .toEqual(project.canvases[0].signs[0].elements?.[0].contours);
  });
});
