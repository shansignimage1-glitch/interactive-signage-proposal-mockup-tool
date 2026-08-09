import { afterEach, describe, expect, it, vi } from 'vitest';
import { readImageAspectRatio } from '../../components/ControlsPanel';

describe('recovered library image proportions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the intrinsic image ratio instead of using placeholder dimensions', async () => {
    class TestImage {
      naturalWidth = 1600;
      naturalHeight = 800;
      width = 1600;
      height = 800;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', TestImage);

    await expect(readImageAspectRatio('data:image/png;base64,dGVzdA==')).resolves.toBe(2);
  });
});
