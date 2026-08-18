import { describe, expect, it } from 'vitest';
import { withoutUndefined } from '../../utils/firestorePayload';

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
});
