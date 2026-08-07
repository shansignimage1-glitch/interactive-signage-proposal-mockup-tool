import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

describe('Vercel Firebase auth proxy security headers', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
    rewrites: Array<{ source: string; destination: string }>;
    headers: HeaderRule[];
  };

  it('proxies Firebase auth helpers without a redirect', () => {
    expect(config.rewrites).toContainEqual({
      source: '/__/auth/:path*',
      destination: 'https://sunny-ship-437805-c5.firebaseapp.com/__/auth/:path*',
    });
  });

  it('permits the Firebase helper nonce only on auth helper routes', () => {
    const authRule = config.headers.find(rule => rule.source === '/__/auth/:path*');
    const appRule = config.headers.find(rule => rule.source === '/((?!__/auth/).*)');
    const authCsp = authRule?.headers.find(header => header.key === 'Content-Security-Policy')?.value;
    const appCsp = appRule?.headers.find(header => header.key === 'Content-Security-Policy')?.value;

    expect(authCsp).toContain("'nonce-firebase-auth-helper'");
    expect(authCsp).toContain("frame-ancestors 'self'");
    expect(appCsp).toBeTruthy();
    expect(appCsp).not.toContain('nonce-firebase-auth-helper');
  });
});
