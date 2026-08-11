import { describe, expect, it } from 'vitest';
import { CalibrationPlane } from '../../types';
import { distortedSourcePoint, getAnchorPoint, getVanishingPoints, projectPlaneDepth, snapSign } from '../../utils/cameraGeometry';

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

  it('keeps the lens centre fixed while remapping image edges', () => {
    expect(distortedSourcePoint({x:500,y:500},{width:1000,height:1000},0.2,0)).toEqual({x:500,y:500});
    expect(distortedSourcePoint({x:1000,y:500},{width:1000,height:1000},0.2,0).x).toBeGreaterThan(1000);
  });
});
