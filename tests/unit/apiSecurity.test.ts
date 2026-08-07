import { afterEach, describe, expect, it } from 'vitest';
import { requireApiKey } from '../../api/_lib/security';

const original = process.env.GEMINI_API_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = original;
});

describe('AI server configuration', () => {
  it('removes byte-order marks and surrounding whitespace from the API key', () => {
    process.env.GEMINI_API_KEY = '\uFEFF  test-key\r\n';
    expect(requireApiKey()).toBe('test-key');
  });

  it('rejects an empty API key after sanitization', () => {
    process.env.GEMINI_API_KEY = '\uFEFF  ';
    expect(() => requireApiKey()).toThrow('SERVER_CONFIG');
  });
});
