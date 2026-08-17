import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isMissingRedirectStateError } from '../../utils/authErrors';
import { prefersRedirectSignIn } from '../../utils/authSignIn';

describe('Firebase redirect error recovery', () => {
  it('recognizes the iPad/Safari missing redirect state failure', () => {
    expect(isMissingRedirectStateError({ code: 'auth/missing-initial-state' })).toBe(true);
    expect(isMissingRedirectStateError(new Error('Unable to process request due to missing initial state. This may happen if browser sessionStorage is inaccessible or accidentally cleared.'))).toBe(true);
  });

  it('does not suppress unrelated authentication failures', () => {
    expect(isMissingRedirectStateError({ code: 'auth/network-request-failed', message: 'Network unavailable' })).toBe(false);
    expect(isMissingRedirectStateError(null)).toBe(false);
  });

  it('routes iPhone and iPad Safari through the same-origin redirect helper', () => {
    const appSource = readFileSync('App.tsx', 'utf8');
    expect(appSource).toContain('signInWithPopup(auth, googleProvider)');
    expect(appSource).toContain('signInWithRedirect(auth, googleProvider)');
    expect(appSource).toContain('prefersRedirectSignIn(window)');

    const environment = (userAgent: string, maxTouchPoints = 0) => ({
      navigator: { userAgent, maxTouchPoints },
    }) as Window;

    expect(prefersRedirectSignIn(environment(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      5,
    ))).toBe(true);
    expect(prefersRedirectSignIn(environment(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      5,
    ))).toBe(true);
    expect(prefersRedirectSignIn(environment(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1',
      5,
    ))).toBe(false);
    expect(prefersRedirectSignIn(environment(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    ))).toBe(false);
  });

  it('bootstraps directly from successful popup and legacy redirect credentials', () => {
    const appSource = readFileSync('App.tsx', 'utf8');
    expect(appSource).toContain('await bootstrapFirebaseUser(credential.user)');
    expect(appSource).toContain('return bootstrapFirebaseUser(result.user)');
    expect(appSource).toContain('authBootstrapPromisesRef.current.get(uid)');
  });

  it('does not show a mount-relative sign-in timeout error', () => {
    const appSource = readFileSync('App.tsx', 'utf8');
    expect(appSource).not.toContain('Sign-in took too long to finish');
    expect(appSource).not.toContain('AUTH_CALLBACK_TIMEOUT_MS');
  });
});
