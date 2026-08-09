import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(),
  getBlob: vi.fn(),
}));

vi.mock('../../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  addDoc: vi.fn(), collection: vi.fn((_db, name) => name), deleteDoc: vi.fn(),
  doc: vi.fn(), getDocs: mocks.getDocs, limit: vi.fn(value => value),
  query: vi.fn((...parts) => parts), setDoc: vi.fn(), where: vi.fn(),
}));
vi.mock('firebase/storage', () => ({
  deleteObject: vi.fn(), getBlob: mocks.getBlob, getDownloadURL: vi.fn(),
  ref: vi.fn((_storage, path) => ({ path })), uploadBytes: vi.fn(),
}));
vi.mock('../../services/imageHash', () => ({ hashDataUri: vi.fn(), dataUriToBlob: vi.fn() }));
vi.mock('../../services/AssetResolver', () => ({ resolveRef: vi.fn(), isDriveRef: vi.fn(() => false) }));

import { LibraryService } from '../../services/LibraryService';

describe('LibraryService image hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    LibraryService.invalidateCache();
  });

  it('hydrates personal-library thumbnails from authenticated Storage blobs', async () => {
    mocks.getDocs.mockResolvedValue({
      docs: [{
        id: 'asset-1',
        data: () => ({
          name: 'Uploaded fascia', imageUrl: 'https://example.invalid/expired-token',
          storagePath: 'users/user-1/library/hash', ownerUid: 'user-1',
          widthMm: 2000, heightMm: 500,
        }),
      }],
    });
    mocks.getBlob.mockResolvedValue(new Blob(['asset'], { type: 'image/png' }));

    const templates = await LibraryService.listPersonal('user-1');

    expect(mocks.getBlob).toHaveBeenCalledWith({ path: 'users/user-1/library/hash' });
    expect(templates).toHaveLength(1);
    expect(templates[0].image).toBe('data:image/png;base64,YXNzZXQ=');
  });
});
