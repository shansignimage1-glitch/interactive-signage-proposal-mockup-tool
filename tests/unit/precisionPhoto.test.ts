import { describe, expect, it } from 'vitest';
import type { Canvas, SiteCapturePhoto } from '../../types';
import { getFinishMeasuringInfo, leanSize, scaleCanvasGeometry } from '../../utils/precisionPhoto';
import { measureLine } from '../../utils/measure';
import { makeProject } from '../fixtures/project';

const baseCanvas = (): Canvas => ({
  ...makeProject().canvases[0],
  id: 'view-1',
  backgroundSize: { width: 8000, height: 6000 },
  signs: [{
    id: 's', name: 'Sign', image: '', signType: 'fascia_ill', extrusionEnabled: true, extrusionDepth: 15, extrusionAngle: 45,
    opacity: 1, blendMode: 'normal', sideColor: '#000', physicalDepthMm: 120,
    corners: [{ x: 1000, y: 1000 }, { x: 3000, y: 1000 }, { x: 3000, y: 2000 }, { x: 1000, y: 2000 }],
  }],
  dimensions: [{ id: 'd', variant: 'linear', type: 'horizontal', start: { x: 1000, y: 3000 }, end: { x: 5000, y: 3000 }, text: '4.00m', color: '#fff', autoMeasured: true }],
  annotations: [{ id: 'a', points: [{ x: 400, y: 800 }, { x: 800, y: 1200 }], color: '#f00', width: 5, note: '', createdAt: 1 }],
  calibration: {
    start: { x: 1000, y: 3000 }, end: { x: 3000, y: 3000 }, realValue: 2, unit: 'm',
    planes: [{ id: 'p', name: 'Wall 1', widthMm: 8000, heightMm: 6000,
      corners: [{ x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 6000 }, { x: 0, y: 6000 }],
      worldCornersMm: [{ x: 0, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 6000 }, { x: 0, y: 6000 }] }],
  },
  placement: {
    snapEnabled: true, showVanishingGuides: false, lens: { enabled: true, k1: 0.05, k2: -0.01 },
    camera: { enabled: true, fieldOfViewDeg: 60, estimated: false, focalLengthPx: 6400, principalPoint: { x: 4000, y: 3000 } },
  },
});

describe('scaleCanvasGeometry', () => {
  it('maps every image-space coordinate into the resized photo', () => {
    const scaled = scaleCanvasGeometry(baseCanvas(), 0.512, 0.512);
    expect(scaled.signs[0].corners[1]).toEqual({ x: 1536, y: 512 });
    expect(scaled.dimensions[0].end).toEqual({ x: 2560, y: 1536 });
    expect(scaled.annotations![0].points[1]).toEqual({ x: 409.6, y: 614.4 });
    expect(scaled.calibration!.end).toEqual({ x: 1536, y: 1536 });
    expect(scaled.calibration!.planes![0].corners[2]).toEqual({ x: 4096, y: 3072 });
    expect(scaled.placement!.camera.principalPoint).toEqual({ x: 2048, y: 1536 });
    expect(scaled.placement!.camera.focalLengthPx).toBeCloseTo(3276.8);
  });

  it('leaves real-world, normalised and screen-space values untouched', () => {
    const original = baseCanvas();
    const scaled = scaleCanvasGeometry(original, 0.512, 0.512);
    expect(scaled.calibration!.realValue).toBe(2);
    expect(scaled.calibration!.planes![0].worldCornersMm).toEqual(original.calibration!.planes![0].worldCornersMm);
    expect(scaled.calibration!.planes![0].widthMm).toBe(8000);
    expect(scaled.placement!.lens).toEqual(original.placement!.lens);
    expect(scaled.annotations![0].width).toBe(5);
    expect(scaled.signs[0].extrusionDepth).toBe(15);
    expect(scaled.signs[0].physicalDepthMm).toBe(120);
    expect(scaled.dimensions[0].text).toBe('4.00m');
  });

  it('keeps every calibrated measurement at the same real-world length', () => {
    const original = baseCanvas();
    const scaled = scaleCanvasGeometry(original, 0.512, 0.512);
    const before = measureLine(original.dimensions[0].start, original.dimensions[0].end, original.calibration!, 'metric');
    const after = measureLine(scaled.dimensions[0].start, scaled.dimensions[0].end, scaled.calibration!, 'metric');
    expect(after).toBe(before);
  });
});

describe('getFinishMeasuringInfo', () => {
  const capture = (overrides: Partial<SiteCapturePhoto> = {}): SiteCapturePhoto => ({
    id: 'cap', label: 'Front', originalRef: 'site-capture://p/cap/original', workingRef: 'site-capture://p/cap/working',
    thumbnailRef: 'site-capture://p/cap/thumbnail', fileName: 'front.jpg', mimeType: 'image/jpeg', byteSize: 1,
    pixelWidth: 8064, pixelHeight: 6048, workingPixelWidth: 4096, workingPixelHeight: 3072, capturedAt: 1, notes: '',
    promotedCanvasId: 'view-1',
    referenceWall: { wallName: '', planeDepthDirection: 'behind', referencePlaneName: '', method: 'laser', notes: '' },
    ...overrides,
  } as SiteCapturePhoto);
  const promotedView = (): Canvas => ({
    ...baseCanvas(), backgroundSize: { width: 4096, height: 3072 }, siteCaptureLink: { captureId: 'cap', annotationUpdatedAt: 1 },
  });

  it('offers to release a promoted site photo original', () => {
    expect(getFinishMeasuringInfo(promotedView(), [capture()])).toEqual(expect.objectContaining({
      kind: 'capture-original', originalRef: 'site-capture://p/cap/original', width: 8064, height: 6048,
    }));
  });

  it('has nothing to finish once the original is unlinked or the view no longer shows that photo', () => {
    expect(getFinishMeasuringInfo(promotedView(), [capture({ originalRef: undefined })])).toBeNull();
    expect(getFinishMeasuringInfo({ ...promotedView(), siteCaptureLink: undefined }, [capture()])).toBeNull();
    expect(getFinishMeasuringInfo(promotedView(), [capture({ promotedCanvasId: 'other-view' })])).toBeNull();
  });

  it('offers to shrink an uploaded background still larger than the lean size', () => {
    expect(getFinishMeasuringInfo(baseCanvas(), [])).toEqual({ kind: 'oversized-background', width: 8000, height: 6000 });
    expect(getFinishMeasuringInfo({ ...baseCanvas(), backgroundSize: { width: 4096, height: 3072 } }, [])).toBeNull();
    expect(getFinishMeasuringInfo({ ...baseCanvas(), backgroundSize: { width: 4097, height: 3072 } }, [])).toBeNull();
  });

  it('computes the lean size preserving aspect ratio and never enlarging', () => {
    expect(leanSize(8064, 6048)).toEqual({ width: 4096, height: 3072 });
    expect(leanSize(6048, 8064)).toEqual({ width: 3072, height: 4096 });
    expect(leanSize(2560, 1920)).toEqual({ width: 2560, height: 1920 });
  });
});
