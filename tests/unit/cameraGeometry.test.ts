import { describe, expect, it } from 'vitest';
import { CalibrationPlane } from '../../types';
import { buildParallelOffsetPlane, distortedSourcePoint, getAnchorPoint, getVanishingPoints, imagePointToParallelPlane, projectExtrudedQuad, projectPlaneDepth, snapSign } from '../../utils/cameraGeometry';
import { getElementExtrusionDepthPx, getElementPhysicalDepthMultiplier, getVisualExtrusionDepthPx } from '../../utils/signExtrusion';

const plane: CalibrationPlane = {
  id: 'wall-1', name: 'Wall 1', widthMm: 1000, heightMm: 1000,
  corners: [{x:100,y:120},{x:900,y:100},{x:850,y:900},{x:140,y:850}],
};

describe('professional placement geometry', () => {
  it('snaps the selected anchor to the image centre', () => {
    const corners = [{x:440,y:450},{x:540,y:450},{x:540,y:500},{x:440,y:500}] as const;
    const result = snapSign([...corners] as any, 'center', {width:1000,height:1000}, null, 30);
    expect(getAnchorPoint(result.corners, 'center')).toEqual({x:500,y:500});
    expect(result.vertical).toBe(500);
    expect(result.horizontal).toBe(500);
  });

  it('finds two finite vanishing points for a perspective plane', () => {
    const result = getVanishingPoints(plane);
    expect(result.horizontal?.x).toBeTypeOf('number');
    expect(result.vertical?.y).toBeTypeOf('number');
  });

  it('projects physical depth with a decomposed camera pose', () => {
    const front = [{x:300,y:300},{x:600,y:295},{x:590,y:550},{x:310,y:555}] as any;
    const back = projectPlaneDepth(front, plane, {enabled:true,fieldOfViewDeg:60,estimated:true}, {width:1000,height:1000}, 100);
    expect(back).not.toBeNull();
    expect(back![0].x).not.toBeCloseTo(front[0].x, 4);
    expect(back!.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });

  it('recovers reference-plane millimetres by intersecting camera rays', () => {
    const camera = {enabled:true,fieldOfViewDeg:60,estimated:true};
    const expected = [{x:0,y:0},{x:1000,y:0},{x:1000,y:1000},{x:0,y:1000}];
    plane.corners.forEach((corner, index) => {
      const world = imagePointToParallelPlane(corner, plane, camera, {width:1000,height:1000}, 0);
      expect(world?.x).toBeCloseTo(expected[index].x, 3);
      expect(world?.y).toBeCloseTo(expected[index].y, 3);
    });
  });

  it('builds a measurable plane 500mm behind a confirmed wall', () => {
    const derived = buildParallelOffsetPlane(
      [{x:180,y:200},{x:760,y:190},{x:730,y:700},{x:210,y:680}],
      plane,
      {enabled:false,fieldOfViewDeg:60,estimated:true},
      {width:1000,height:1000},
      500,
      {id:'wall-2',name:'Wall 2'},
    );
    expect(derived).not.toBeNull();
    expect(derived?.referencePlaneId).toBe('wall-1');
    expect(derived?.offsetMm).toBe(500);
    expect(derived?.cameraConfidence).toBe('estimated');
    expect(derived?.worldCornersMm).toHaveLength(4);
    expect(derived?.widthMm).toBeGreaterThan(0);
    expect(derived?.heightMm).toBeGreaterThan(0);
  });

  it('makes raised artwork returns converge with a right-wall perspective', () => {
    const rightWall: CalibrationPlane = {
      id: 'right-wall', name: 'Right wall', widthMm: 3000, heightMm: 1800,
      corners: [{x:180,y:180},{x:900,y:300},{x:900,y:700},{x:180,y:820}],
    };
    const face = [{x:360,y:330},{x:760,y:390},{x:760,y:610},{x:360,y:670}] as [
      {x:number;y:number}, {x:number;y:number}, {x:number;y:number}, {x:number;y:number}
    ];
    const raised = projectExtrudedQuad(
      face,
      rightWall,
      {enabled:false,fieldOfViewDeg:60,estimated:true},
      {width:1080,height:900},
      120,
      18,
      0,
    );
    const offsets = raised.map((point, index) => ({ x: point.x - face[index].x, y: point.y - face[index].y }));
    expect(Math.max(...offsets.map(offset => offset.x)) - Math.min(...offsets.map(offset => offset.x))).toBeGreaterThan(0.1);
    expect(Math.max(...offsets.map(offset => offset.y)) - Math.min(...offsets.map(offset => offset.y))).toBeGreaterThan(0.1);
  });

  it('keeps perspective returns visibly deep in visual extrusion mode', () => {
    const rightWall: CalibrationPlane = {
      id: 'right-wall', name: 'Right wall', widthMm: 3000, heightMm: 1800,
      corners: [{x:180,y:180},{x:900,y:300},{x:900,y:700},{x:180,y:820}],
    };
    const face = [{x:360,y:330},{x:760,y:390},{x:760,y:610},{x:360,y:670}] as [
      {x:number;y:number}, {x:number;y:number}, {x:number;y:number}, {x:number;y:number}
    ];
    const requestedVisualDepth = 60;
    const raised = projectExtrudedQuad(
      face,
      rightWall,
      {enabled:false,fieldOfViewDeg:60,estimated:true},
      {width:1080,height:900},
      100,
      requestedVisualDepth,
      0,
      'visual',
    );
    const magnitudes = raised.map((point, index) => Math.hypot(point.x - face[index].x, point.y - face[index].y));
    expect(magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length).toBeCloseTo(requestedVisualDepth, 4);
    expect(Math.max(...magnitudes) - Math.min(...magnitudes)).toBeGreaterThan(0.1);
  });

  it('keeps visual depth proportional when the source photo resolution changes', () => {
    const small = [{x:0,y:0},{x:100,y:0},{x:100,y:60},{x:0,y:60}] as any;
    const large = [{x:0,y:0},{x:1000,y:0},{x:1000,y:600},{x:0,y:600}] as any;
    expect(getVisualExtrusionDepthPx(small, 15)).toBeCloseTo(5, 6);
    expect(getVisualExtrusionDepthPx(large, 15)).toBeCloseTo(50, 6);
    expect(getVisualExtrusionDepthPx(small, 15) / 100).toBeCloseTo(getVisualExtrusionDepthPx(large, 15) / 1000, 6);
  });

  it('keeps each element depth independent when a deeper element is disabled', () => {
    const corners = [{x:0,y:0},{x:600,y:0},{x:600,y:300},{x:0,y:300}] as any;
    const shallow = getElementExtrusionDepthPx(corners, 1200, 30);
    const deep = getElementExtrusionDepthPx(corners, 1200, 90);
    expect(shallow).toBeCloseTo(15, 6);
    expect(deep).toBeCloseTo(45, 6);
    // Re-evaluating the shallower element without its neighbour is invariant.
    expect(getElementExtrusionDepthPx(corners, 1200, 30)).toBe(shallow);
    expect(getElementPhysicalDepthMultiplier(1200, 90, 15)).toBeGreaterThan(getElementPhysicalDepthMultiplier(1200, 30, 15));
  });

  it('makes physical camera projection respond to the millimetre depth control', () => {
    const camera = {enabled:true,fieldOfViewDeg:60,estimated:true};
    const face = [{x:300,y:300},{x:600,y:295},{x:590,y:550},{x:310,y:555}] as any;
    const shallow = projectExtrudedQuad(face, plane, camera, {width:1000,height:1000}, 50, 60, 0, 'physical');
    const deep = projectExtrudedQuad(face, plane, camera, {width:1000,height:1000}, 250, 60, 0, 'physical');
    const meanOffset = (quad: typeof shallow) => quad.reduce((sum, point, index) => sum + Math.hypot(point.x - face[index].x, point.y - face[index].y), 0) / quad.length;
    expect(meanOffset(deep)).toBeGreaterThan(meanOffset(shallow) * 2);
  });

  it('keeps the editable direction fallback for an uncalibrated sign', () => {
    const face = [{x:100,y:100},{x:300,y:100},{x:300,y:200},{x:100,y:200}] as any;
    const raised = projectExtrudedQuad(face, null, null, {width:500,height:400}, 100, 20, 0);
    raised.forEach((point, index) => {
      expect(point.x - face[index].x).toBeCloseTo(-20, 6);
      expect(point.y - face[index].y).toBeCloseTo(0, 6);
    });
  });

  it('keeps the lens centre fixed while remapping image edges', () => {
    expect(distortedSourcePoint({x:500,y:500},{width:1000,height:1000},0.2,0)).toEqual({x:500,y:500});
    expect(distortedSourcePoint({x:1000,y:500},{width:1000,height:1000},0.2,0).x).toBeGreaterThan(1000);
  });
});
