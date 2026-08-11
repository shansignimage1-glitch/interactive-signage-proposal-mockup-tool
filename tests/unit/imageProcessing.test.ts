import { afterEach, describe, expect, it, vi } from 'vitest';
import { optimizeImageBlob } from '../../services/imageProcessing';

const installImageMocks = (output: Blob) => {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1200, height: 800, close }));
  const drawImage = vi.fn();
  const toBlob = vi.fn((callback: BlobCallback, type?: string) => callback(new Blob([output], { type })));
  const originalCreateElement = document.createElement.bind(document);
  const createElement = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
    if (tagName !== 'canvas') return originalCreateElement(tagName, options);
    return {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob,
    } as unknown as HTMLCanvasElement;
  }) as typeof document.createElement);
  return { close, createElement, drawImage, toBlob };
};

describe('mobile image processing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a small web-safe JPEG unchanged', async () => {
    const source = new Blob(['jpeg-source'], { type: 'image/jpeg' });
    const mocks = installImageMocks(new Blob(['unused']));

    const result = await optimizeImageBlob(source, 4096);

    expect(result).toBe(source);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.createElement).not.toHaveBeenCalled();
  });

  it('converts a small HEIC capture to a JPEG working copy', async () => {
    const source = new Blob(['heic-original'], { type: 'image/heic' });
    const mocks = installImageMocks(new Blob(['jpeg-working']));

    const result = await optimizeImageBlob(source, 4096);

    expect(result).not.toBe(source);
    expect(result.type).toBe('image/jpeg');
    expect(mocks.drawImage).toHaveBeenCalledOnce();
    expect(mocks.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.86);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
