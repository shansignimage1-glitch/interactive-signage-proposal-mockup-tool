type BrowserEnvironment = Pick<Window, 'navigator'>;

export const prefersRedirectSignIn = ({ navigator }: BrowserEnvironment): boolean => {
  const userAgent = navigator.userAgent || '';
  const isAppleMobile = /iPad|iPhone|iPod/i.test(userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(userAgent));
  const isSafari = /Safari/i.test(userAgent)
    && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Edg/i.test(userAgent);
  return isAppleMobile && isSafari;
};
