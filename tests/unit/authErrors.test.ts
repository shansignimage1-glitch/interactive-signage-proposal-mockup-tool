import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isMissingRedirectStateError } from '../../utils/authErrors';

describe('Firebase redirect error recovery', () => {
  it('recognizes the iPad/Safari missing redirect state failure', () => {
    expect(isMissingRedirectStateError({ code: 'auth/missing-initial-state' })).toBe(true);
    expect(isMissingRedirectStateError(new Error('Unable to process request due to missing initial state. This may happen if browser sessionStorage is inaccessible or accidentally cleared.'))).toBe(true);
  });

  it('does not suppress unrelated authentication failures', () => {
    expect(isMissingRedirectStateError({ code: 'auth/network-request-failed', message: 'Network unavailable' })).toBe(false);
    expect(isMissingRedirectStateError(null)).toBe(false);
  });

  it('does not route iPad authentication through redirect storage', () => {
    const appSource = readFileSync('App.tsx', 'utf8');
    expect(appSource).toContain('signInWithPopup(auth, googleProvider)');
    expect(appSource).not.toContain('signInWithRedirect');
    expect(appSource).not.toContain('prefersRedirectSignIn');
  });
});
