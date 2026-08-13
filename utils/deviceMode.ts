export const PHONE_MAX_SHORT_SIDE_CSS_PX = 599;

export interface DeviceModeEnvironment {
  search: string;
  screenWidth: number;
  screenHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  coarsePointer: boolean;
  maxTouchPoints: number;
}

const usableDimension = (value: number): value is number => Number.isFinite(value) && value > 0;

export const isPhoneSizedTouchDevice = ({
  screenWidth,
  screenHeight,
  viewportWidth,
  viewportHeight,
  coarsePointer,
  maxTouchPoints,
}: DeviceModeEnvironment): boolean => {
  if (!coarsePointer && maxTouchPoints < 1) return false;

  // Browser chrome, the Safari sidebar, and the onscreen keyboard can shrink
  // the content viewport. The physical screen's short side stays stable and
  // separates phones (<600 CSS px) from iPads/tablets (>=600 CSS px).
  const width = usableDimension(screenWidth) ? screenWidth : viewportWidth;
  const height = usableDimension(screenHeight) ? screenHeight : viewportHeight;
  if (!usableDimension(width) || !usableDimension(height)) return false;

  return Math.min(width, height) <= PHONE_MAX_SHORT_SIDE_CSS_PX;
};

export const shouldUsePhoneCapture = (environment: DeviceModeEnvironment): boolean => {
  const params = new URLSearchParams(environment.search);
  if (params.get('editor') === '1') return false;
  if (params.get('mobileCapture') === '1') return true;
  return isPhoneSizedTouchDevice(environment);
};

export const readDeviceModeEnvironment = (browserWindow: Window): DeviceModeEnvironment => ({
  search: browserWindow.location.search,
  screenWidth: browserWindow.screen?.width ?? 0,
  screenHeight: browserWindow.screen?.height ?? 0,
  viewportWidth: browserWindow.innerWidth,
  viewportHeight: browserWindow.innerHeight,
  coarsePointer: browserWindow.matchMedia?.('(pointer: coarse)').matches ?? false,
  maxTouchPoints: browserWindow.navigator?.maxTouchPoints ?? 0,
});
