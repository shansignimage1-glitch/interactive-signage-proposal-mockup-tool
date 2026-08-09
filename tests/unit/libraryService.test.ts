import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  getDownloadURL: vi.fn(),
  listAll: vi.fn(),
  deleteObject: vi.fn(),
  deleteDoc: vi.fn(),
  setDoc: vi.fn(),
  uploadBytes: vi.fn(),
  hashDataUri: vi.fn(),
  dataUriToBlob: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  addDoc: vi.fn(), collection: vi.fn((_db, name) => name), deleteDoc: mocks.deleteDoc,
  doc: vi.fn(), getDoc: mocks.getDoc, getDocs: mocks.getDocs, limit: vi.fn(value => value),
  query: vi.fn((...parts) => parts), setDoc: mocks.setDoc, where: vi.fn(),
}));
vi.mock('firebase/storage', () => ({
  deleteObject: mocks.deleteObject, getDownloadURL: mocks.getDownloadURL,
  listAll: mocks.listAll,
  ref: vi.fn((_storage, path) => ({ path })), uploadBytes: mocks.uploadBytes,
}));
vi.mock('../../services/imageHash', () => ({ hashDataUri: mocks.hashDataUri, dataUriToBlob: mocks.dataUriToBlob }));
vi.mock('../../services/AssetResolver', () => ({ resolveRef: vi.fn(), isDriveRef: vi.fn(() => false) }));

import { LibraryService, materializeTemplateDataUri, refreshTemplateImageUrl } from '../../services/LibraryService';

describe('LibraryService loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.listAll.mockResolvedValue({ items: [] });
    mocks.deleteObject.mockResolvedValue(undefined);
    mocks.deleteDoc.mockResolvedValue(undefined);
    mocks.setDoc.mockResolvedValue(undefined);
    mocks.uploadBytes.mockResolvedValue(undefined);
    mocks.hashDataUri.mockResolvedValue('same-hash');
    mocks.dataUriToBlob.mockReturnValue(new Blob(['asset'], { type: 'image/png' }));
    LibraryService.invalidateCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    const templates = await LibraryService.listPersonal('user-1');

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.getDownloadURL).not.toHaveBeenCalled();
    expect(mocks.listAll).not.toHaveBeenCalled();
    expect(templates).toHaveLength(1);
    expect(templates[0].image).toBe('https://example.invalid/expired-token');
  });

  it('recovers uploaded files that lost their personal-library metadata record', async () => {
    mocks.getDocs.mockResolvedValue({ docs: [] });
    const orphan = {
      name: 'abc123',
      fullPath: 'users/user-1/library/abc123',
    };
    mocks.listAll.mockResolvedValue({ items: [orphan] });
    mocks.getDownloadURL.mockResolvedValue('https://example.com/recovered-token');

    const saved = await LibraryService.listPersonal('user-1');
    const templates = await LibraryService.recoverPersonalUploads('user-1', saved);

    expect(mocks.listAll).toHaveBeenCalledWith({ path: 'users/user-1/library' });
    expect(mocks.getDownloadURL).toHaveBeenCalledWith(orphan);
    expect(templates).toEqual([expect.objectContaining({
      name: 'Recovered upload 1',
      image: 'https://example.com/recovered-token',
      storagePath: orphan.fullPath,
      source: 'personal',
    })]);
    expect(templates[0].docId).toBeUndefined();
    expect(templates[0]).toEqual(expect.objectContaining({
      category: 'Recovered',
      recovered: true,
      width: 1,
      height: 1,
    }));
  });

  it('deletes a recovered personal upload without touching a missing Firestore record', async () => {
    const template = {
      id: 'personal_recovered', name: 'Recovered upload 1', category: 'Fascia',
      image: 'https://example.com/recovered-token', width: 2000, height: 500,
      source: 'personal' as const, storagePath: 'users/user-1/library/orphan',
    };

    await LibraryService.deletePersonal(template);

    expect(mocks.deleteDoc).not.toHaveBeenCalled();
    expect(mocks.deleteObject).toHaveBeenCalledWith({ path: template.storagePath });
  });

  it('keeps a tombstone when its personal Storage object cannot be deleted', async () => {
    const error = Object.assign(new Error('Storage offline'), { code: 'storage/retry-limit-exceeded' });
    mocks.deleteObject.mockRejectedValue(error);
    const template = {
      id: 'personal_saved', docId: 'user-1_hash', name: 'Saved upload', category: 'Fascia',
      image: 'https://example.com/token', width: 2000, height: 500,
      source: 'personal' as const, storagePath: 'users/user-1/library/hash',
    };

    await expect(LibraryService.deletePersonal(template)).rejects.toBe(error);

    expect(mocks.setDoc).toHaveBeenCalledWith(undefined, expect.objectContaining({ deleting: true }), { merge: true });
    expect(mocks.deleteDoc).not.toHaveBeenCalled();
  });

  it('keeps the tombstone when final metadata cleanup must be retried', async () => {
    const error = new Error('Firestore offline');
    mocks.deleteDoc.mockRejectedValue(error);
    const template = {
      id: 'personal_saved', docId: 'user-1_hash', name: 'Saved upload', category: 'Fascia',
      image: 'https://example.com/token', width: 2000, height: 500,
      source: 'personal' as const, storagePath: 'users/user-1/library/hash',
    };

    await expect(LibraryService.deletePersonal(template)).rejects.toBe(error);

    expect(mocks.setDoc).toHaveBeenCalledWith(undefined, expect.objectContaining({ deleting: true }), { merge: true });
    expect(mocks.deleteObject).toHaveBeenCalledOnce();
  });

  it('reports a Storage recovery timeout instead of silently returning an empty library', async () => {
    const error = new Error('Checking uploaded signs timed out');
    mocks.listAll.mockRejectedValue(error);

    await expect(LibraryService.recoverPersonalUploads('user-1', [])).rejects.toBe(error);
  });

  it('keeps an individual upload visible when resolving its URL times out', async () => {
    const orphan = { name: 'slow-hash', fullPath: 'users/user-1/library/slow-hash' };
    mocks.listAll.mockResolvedValue({ items: [orphan] });
    mocks.getDownloadURL.mockRejectedValue(new Error('Recovering an uploaded sign timed out'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const recovered = await LibraryService.recoverPersonalUploads('user-1', []);

    expect(recovered).toEqual([expect.objectContaining({
      name: 'Recovered upload 1', image: '', storagePath: orphan.fullPath,
    })]);
  });

  it('automatically finishes a tombstoned personal deletion during recovery', async () => {
    const tombstone = {
      id: 'personal_deleting', docId: 'user-1_hash', name: 'Deleting upload', category: 'Fascia',
      image: 'https://example.com/token', width: 2000, height: 500,
      source: 'personal' as const, storagePath: 'users/user-1/library/hash',
      deleting: true, deletionId: 'delete-1',
    };
    mocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ deleting: true, deletionId: 'delete-1' }),
    });

    const recovered = await LibraryService.recoverPersonalUploads('user-1', [tombstone]);

    expect(mocks.deleteObject).toHaveBeenCalledWith({ path: tombstone.storagePath });
    expect(mocks.deleteDoc).toHaveBeenCalledOnce();
    expect(recovered).toEqual([]);
  });

  it('does not clean up a document that is no longer the same tombstone', async () => {
    const tombstone = {
      id: 'personal_deleting', docId: 'user-1_hash', name: 'Deleting upload', category: 'Fascia',
      image: 'https://example.com/token', width: 2000, height: 500,
      source: 'personal' as const, storagePath: 'users/user-1/library/hash',
      deleting: true, deletionId: 'delete-old',
    };
    mocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ deleting: false, deletionId: null }),
    });

    await LibraryService.recoverPersonalUploads('user-1', [tombstone]);

    expect(mocks.deleteObject).not.toHaveBeenCalled();
    expect(mocks.deleteDoc).not.toHaveBeenCalled();
  });

  it('uses a unique object path for repeated saves of identical personal artwork', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'storage/object-not-found' });
    mocks.getDownloadURL
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce('https://example.com/first')
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce('https://example.com/second');
    const input = {
      name: 'Same artwork', category: 'Fascia', widthMm: 2000, heightMm: 500,
      dataUri: 'data:image/png;base64,YXNzZXQ=', signType: 'fascia_non_ill' as const,
    };

    await LibraryService.saveToPersonal('user-1', input);
    await LibraryService.saveToPersonal('user-1', input);

    const paths = mocks.uploadBytes.mock.calls.map(([imageRef]) => imageRef.path as string);
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths.every(path => path.startsWith('users/user-1/library/same-hash_'))).toBe(true);
  });

  it('loads and deduplicates the persisted download URL without an authenticated blob request', async () => {
    mocks.fetch.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['asset'], { type: 'image/png' }),
    });
    const template = {
      id: 'personal_asset-1', name: 'Uploaded fascia', category: 'Fascia',
      image: 'https://example.com/download-token', width: 2000, height: 500,
      source: 'personal' as const, storagePath: 'users/user-1/library/hash',
    };

    const [first, second] = await Promise.all([
      materializeTemplateDataUri(template),
      materializeTemplateDataUri(template),
    ]);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith('https://example.com/download-token');
    expect(mocks.getDownloadURL).not.toHaveBeenCalled();
    expect(first).toBe('data:image/png;base64,YXNzZXQ=');
    expect(second).toBe(first);
  });

  it('refreshes an expired download URL through the stable Storage path', async () => {
    mocks.fetch
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(['fresh'], { type: 'image/png' }),
      });
    mocks.getDownloadURL.mockResolvedValue('https://example.com/fresh-token');
    const template = {
      id: 'shared_asset-1', name: 'Shared fascia', category: 'Fascia',
      image: 'https://example.com/expired-token', width: 2000, height: 500,
      source: 'shared' as const, storagePath: 'library/hash',
    };

    const image = await materializeTemplateDataUri(template);

    expect(mocks.getDownloadURL).toHaveBeenCalledWith({ path: 'library/hash' });
    expect(mocks.fetch).toHaveBeenNthCalledWith(1, 'https://example.com/expired-token');
    expect(mocks.fetch).toHaveBeenNthCalledWith(2, 'https://example.com/fresh-token');
    expect(image).toBe('data:image/png;base64,ZnJlc2g=');
  });

  it('retries after refresh even when Storage returns the same download URL', async () => {
    mocks.fetch
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(['restored'], { type: 'image/png' }),
      });
    mocks.getDownloadURL.mockResolvedValue('https://example.com/same-token');
    const template = {
      id: 'shared_restored', name: 'Restored shared sign', category: 'Fascia',
      image: 'https://example.com/same-token', width: 2000, height: 500,
      source: 'shared' as const, storagePath: 'library/restored-hash',
    };

    const image = await materializeTemplateDataUri(template);

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(image).toBe('data:image/png;base64,cmVzdG9yZWQ=');
  });

  it('reuses a thumbnail refresh when the same template is selected', async () => {
    mocks.getDownloadURL.mockResolvedValue('https://example.com/refreshed-token');
    mocks.fetch.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['selected'], { type: 'image/png' }),
    });
    const template = {
      id: 'shared_asset-1', name: 'Shared fascia', category: 'Fascia',
      image: 'https://example.com/expired-token', width: 2000, height: 500,
      source: 'shared' as const, storagePath: 'library/hash',
    };

    await refreshTemplateImageUrl(template);
    const image = await materializeTemplateDataUri(template);

    expect(mocks.getDownloadURL).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith('https://example.com/refreshed-token');
    expect(image).toBe('data:image/png;base64,c2VsZWN0ZWQ=');
  });

  it('never deletes a content-addressed shared image with its metadata record', async () => {
    const template = {
      id: 'shared_asset-1', docId: 'asset-1', name: 'Shared fascia', category: 'Fascia',
      image: 'https://example.com/download-token', width: 2000, height: 500,
      source: 'shared' as const, storagePath: 'library/shared-hash',
    };

    await LibraryService.deleteShared(template);

    expect(mocks.deleteDoc).toHaveBeenCalledOnce();
    expect(mocks.getDocs).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });
});
