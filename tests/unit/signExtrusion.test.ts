import { describe, expect, it } from 'vitest';
import { Sign } from '../../types';
import { defaultExtrusionModeForType, getBackingDepth, getSignExtrusionPlan } from '../../utils/signExtrusion';

const sign = (updates: Partial<Sign> = {}): Sign => ({
  id: 'sign-1',
  name: 'Test sign',
  image: 'data:image/png;base64,AA==',
  corners: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }],
  signType: 'fascia_non_ill',
  extrusionEnabled: true,
  extrusionDepth: 15,
  extrusionAngle: 45,
  opacity: 1,
  blendMode: 'normal',
  sideColor: '#333333',
  ...updates,
});

describe('professional sign extrusion layers', () => {
  it('uses a shallow backing layer plus raised artwork for fascia signs', () => {
    const backed = sign({
      extrusionMode: 'backed',
      backingDepth: 5,
      elements: [{ id: 'letter', name: 'Letter', contours: [], depth: 20, enabled: true }],
    });
    const plan = getSignExtrusionPlan(backed);
    expect(plan.renderBacking).toBe(true);
    expect(plan.renderFullFace).toBe(true);
    expect(plan.renderElements).toBe(true);
    expect(getBackingDepth(backed)).toBeLessThan(backed.extrusionDepth);
  });

  it('removes the image rectangle for individual channel letters', () => {
    const individual = sign({
      signType: 'channel_face',
      extrusionMode: 'individual',
      elements: [{ id: 'letter', name: 'Letter', contours: [], depth: 20, enabled: true }],
    });
    const plan = getSignExtrusionPlan(individual);
    expect(plan.renderBacking).toBe(false);
    expect(plan.renderFullFace).toBe(false);
    expect(plan.renderElements).toBe(true);
  });

  it('keeps a flat fallback visible until automatic artwork detection completes', () => {
    const pending = getSignExtrusionPlan(sign({ signType: 'channel_face', extrusionMode: 'individual', elements: undefined }));
    expect(pending.renderFullFace).toBe(true);
    expect(pending.renderElements).toBe(false);
  });

  it('selects backed and individual defaults from fabrication type', () => {
    expect(defaultExtrusionModeForType('fascia_ill')).toBe('backed');
    expect(defaultExtrusionModeForType('channel_halo')).toBe('individual');
    expect(defaultExtrusionModeForType('flat_cut_standoff')).toBe('individual');
  });
});
