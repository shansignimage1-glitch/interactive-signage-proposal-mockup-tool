import { Sign, SignType } from '../types';

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
