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

  it('decodes URL-encoded SVG data URIs used by the built-in sign artwork', async () => {
    const svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Ctext%3ESIGN IMAGE%3C/text%3E%3C/svg%3E";
    const blob = dataUriToBlob(svg);

    expect(blob.type).toBe('image/svg+xml');
    expect(await blob.text()).toBe("<svg xmlns='http://www.w3.org/2000/svg'><text>SIGN IMAGE</text></svg>");
  });
});
