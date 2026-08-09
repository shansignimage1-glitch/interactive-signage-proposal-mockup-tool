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

import { LibraryService, materializeTemplateDataUri } from '../../services/LibraryService';

describe('LibraryService loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    LibraryService.invalidateCache();
  });

  it('returns personal-library metadata without waiting for image blobs', async () => {
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
    mocks.getBlob.mockReturnValue(new Promise(() => undefined));

    const templates = await LibraryService.listPersonal('user-1');

    expect(mocks.getBlob).not.toHaveBeenCalled();
    expect(templates).toHaveLength(1);
    expect(templates[0].image).toBe('https://example.invalid/expired-token');
  });

  it('loads and deduplicates an authenticated thumbnail only when requested', async () => {
    mocks.getBlob.mockResolvedValue(new Blob(['asset'], { type: 'image/png' }));
    const template = {
      id: 'personal_asset-1', name: 'Uploaded fascia', category: 'Fascia',
      image: 'https://example.invalid/expired-token', width: 2000, height: 500,
      source: 'personal' as const, storagePath: 'users/user-1/library/hash',
    };

    const [first, second] = await Promise.all([
      materializeTemplateDataUri(template),
      materializeTemplateDataUri(template),
    ]);

    expect(mocks.getBlob).toHaveBeenCalledTimes(1);
    expect(mocks.getBlob).toHaveBeenCalledWith({ path: 'users/user-1/library/hash' });
    expect(first).toBe('data:image/png;base64,YXNzZXQ=');
    expect(second).toBe(first);
  });
});
