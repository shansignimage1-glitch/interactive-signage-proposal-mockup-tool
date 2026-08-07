import { describe, expect, it } from 'vitest';
import { blobToDataUri, dataUriToBlob, hashDataUri } from '../../services/imageHash';

describe('image hashing', () => {
  const png = 'data:image/png;base64,aGVsbG8=';

  it('produces stable SHA-256 content identifiers', async () => {
    const first = await hashDataUri(png);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashDataUri(png)).toBe(first);
    expect(await hashDataUri(`${png}x`)).not.toBe(first);
  });

  it('round-trips data URIs through Blob storage', async () => {
    const blob = dataUriToBlob(png);
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('hello');
    expect(await blobToDataUri(blob)).toBe(png);
  });
});
