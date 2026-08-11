import { Sign, SignType } from '../types';

// The legacy 15px default was authored against an approximately 300px-wide
// sign. Treating the control as a relative design unit keeps the same 5%
// return after a high-resolution photo is fitted to desktop or tablet.
export const VISUAL_EXTRUSION_REFERENCE_WIDTH_PX = 300;

export const getVisualExtrusionDepthPx = (
  corners: Sign['corners'],
  depthUnits: number,
): number => {
  const topWidth = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const bottomWidth = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
  const placedWidth = (topWidth + bottomWidth) / 2;
  const safeDepth = Math.max(0, Math.min(100, Number.isFinite(depthUnits) ? depthUnits : 15));
  return placedWidth * safeDepth / VISUAL_EXTRUSION_REFERENCE_WIDTH_PX;
};

/** Preserves each detected element's source-image depth independently. */
export const getElementExtrusionDepthPx = (
  corners: Sign['corners'],
  sourceWidth: number,
  elementDepthPx: number,
): number => {
  const topWidth = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const bottomWidth = Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y);
  const placedWidth = (topWidth + bottomWidth) / 2;
  return placedWidth * Math.max(0, elementDepthPx) / Math.max(1, sourceWidth);
};

/** Maps a per-element source depth to the global physical-depth control. */
export const getElementPhysicalDepthMultiplier = (
  sourceWidth: number,
  elementDepthPx: number,
  globalDepthUnits: number,
): number => {
  const referenceDepthPx = Math.max(1, sourceWidth * Math.max(1, globalDepthUnits) / VISUAL_EXTRUSION_REFERENCE_WIDTH_PX);
  return Math.max(0, elementDepthPx) / referenceDepthPx;
};

const BACKED_SIGN_TYPES = new Set<SignType>([
  'fascia_non_ill',
  'fascia_ill',
  'lightbox_cabinet',
  'blade_sign',
  'totem',
  'awning',
]);

export const defaultExtrusionModeForType = (signType: SignType): 'backed' | 'individual' =>
  BACKED_SIGN_TYPES.has(signType) ? 'backed' : 'individual';

export const getSignExtrusionMode = (sign: Sign): 'backed' | 'individual' =>
  sign.extrusionMode ?? defaultExtrusionModeForType(sign.signType ?? 'fascia_non_ill');

export const getBackingDepth = (sign: Sign): number => {
  const letterDepth = Number.isFinite(sign.extrusionDepth) ? sign.extrusionDepth : 15;
  const requested = Number.isFinite(sign.backingDepth) ? sign.backingDepth! : Math.max(2, Math.round(letterDepth / 3));
  return Math.max(0, Math.min(requested, Math.max(0, letterDepth * 0.8)));
};

export const getSignExtrusionPlan = (sign: Sign) => {
  const activeElements = sign.elements?.filter(element => element.enabled) ?? [];
  const enabled = sign.extrusionEnabled;
  const mode = getSignExtrusionMode(sign);
  return {
    mode,
    activeElements,
    renderBacking: enabled && mode === 'backed',
    renderElements: enabled && activeElements.length > 0,
    // While automatic detection is still pending, retain the flat artwork so
    // the sign never disappears. Individual mode removes the image rectangle
    // as soon as masked letter/logo geometry is ready.
    renderFullFace: !enabled || mode === 'backed' || activeElements.length === 0,
  };
};
