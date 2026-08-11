import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeProject } from '../fixtures/project';

const mocks = vi.hoisted(() => {
  const transactionSet = vi.fn();
  const getDownloadURL = vi.fn();
  const uploadBytes = vi.fn();
  const uploadImage = vi.fn();
  const ensureReady = vi.fn();
  const connector = {
    id: 'google', available: true, isConnected: () => true, ensureReady,
    uploadImage, deleteImage: vi.fn(), deleteAllAppData: vi.fn(),
  };
  return { transactionSet, getDownloadURL, uploadBytes, uploadImage, ensureReady, connector, remoteExists: false, remoteRevision: 0 };
});

vi.mock('../../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db, path) => ({ path })),
  where: vi.fn((...args) => args),
  query: vi.fn((...args) => args[0]),
  limit: vi.fn((value) => value),
  doc: vi.fn((_db, collectionName, id) => ({ collectionName, id })),
  getDoc: vi.fn(),
  getDocs: vi.fn(async () => ({ docs: [], empty: true })),
  deleteDoc: vi.fn(),
  setDoc: vi.fn(),
  runTransaction: vi.fn(async (_db, callback) => callback({
    get: vi.fn(async () => ({ exists: () => mocks.remoteExists, data: () => ({ cloudRevision: mocks.remoteRevision }) })),
    set: mocks.transactionSet,
  })),
}));
vi.mock('firebase/storage', () => ({
  ref: vi.fn((_storage, path) => ({ path, name: path.split('/').pop() })),
  getDownloadURL: mocks.getDownloadURL,
  uploadBytes: mocks.uploadBytes,
  listAll: vi.fn(async () => ({ items: [], prefixes: [] })),
  deleteObject: vi.fn(),
}));
vi.mock('../../services/imageProcessing', () => ({
  assertStorageCapacity: vi.fn(async () => undefined),
  optimizeDataUri: vi.fn(async (value: string) => value),
}));
vi.mock('../../services/driveConnectors', () => ({
  connectors: [mocks.connector],
  getActiveConnector: () => mocks.connector,
  getConnectorForRef: () => mocks.connector,
}));
vi.mock('../../services/AssetResolver', () => ({
  getKnownRef: () => undefined,
  recordKnownRef: vi.fn(),
  isDriveRef: (value?: string) => value?.startsWith('gdrive://') ?? false,
  resolveProjectImages: async (state: unknown) => ({ state, failedRefs: [], needsReconnect: false }),
}));

import { getSiteCaptureAsset, makeSiteCaptureAssetRef, putSiteCaptureAsset, StorageService } from '../../services/StorageService';

describe('StorageService save/load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureReady.mockResolvedValue(true);
    mocks.remoteExists = false;
    mocks.remoteRevision = 0;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  it('saves and reopens complete projects in IndexedDB', async () => {
    const project = makeProject({ projectId: `local-${Date.now()}`, projectName: 'Reopen Me' });
    await StorageService.saveProjectLocal(project);
    const loaded = await StorageService.loadProjectLocal(project.projectId);
    expect(loaded).toEqual(project);
    expect((await StorageService.listProjectsLocal()).some(item => item.id === project.projectId)).toBe(true);
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('falls back to Firebase Storage when the selected Drive upload fails', async () => {
    const image = 'data:image/png;base64,aGVsbG8=';
    const project = makeProject({ projectId: `fallback-${Date.now()}` });
    project.canvases[0].backgroundImage = image;
    mocks.uploadImage.mockRejectedValue(new Error('Drive unavailable'));
    mocks.getDownloadURL.mockRejectedValueOnce(new Error('not uploaded')).mockResolvedValue('https://storage.example/image-hash');

    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('cloud');
    expect(mocks.uploadImage).toHaveBeenCalledOnce();
    expect(mocks.uploadBytes).toHaveBeenCalledOnce();
    expect(mocks.transactionSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        canvases: [expect.objectContaining({ backgroundImage: 'https://storage.example/image-hash' })],
      }),
    );
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('queues signed-in projects while offline and keeps the latest local copy', async () => {
    const project = makeProject({ projectId: `offline-${Date.now()}` });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('queued');
    expect(await StorageService.loadProjectLocal(project.projectId)).toEqual(project);
    expect(mocks.transactionSet).not.toHaveBeenCalled();
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('detects a newer cloud revision instead of overwriting another device', async () => {
    const project = makeProject({ projectId: `conflict-${Date.now()}`, cloudRevision: 2 });
    mocks.remoteExists = true;
    mocks.remoteRevision = 3;
    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('conflict');
    expect(mocks.transactionSet).not.toHaveBeenCalled();
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('keeps guest projects local and never touches cloud services', async () => {
    const project = makeProject({ projectId: `guest-${Date.now()}` });
    await expect(StorageService.saveProject('guest_test', project)).resolves.toBe('local');
    expect(mocks.transactionSet).not.toHaveBeenCalled();
    expect(mocks.uploadImage).not.toHaveBeenCalled();
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('uploads site-capture originals separately and stores only cloud references in Firestore', async () => {
    const project = makeProject({ projectId: `capture-${Date.now()}` });
    const captureId = 'capture-1';
    const originalRef = makeSiteCaptureAssetRef(project.projectId, captureId, 'original');
    const workingRef = makeSiteCaptureAssetRef(project.projectId, captureId, 'working');
    const thumbnailRef = makeSiteCaptureAssetRef(project.projectId, captureId, 'thumbnail');
    await putSiteCaptureAsset(originalRef, new Blob(['untouched-original'], { type: 'image/jpeg' }));
    await putSiteCaptureAsset(workingRef, new Blob(['working'], { type: 'image/jpeg' }));
    await putSiteCaptureAsset(thumbnailRef, new Blob(['thumb'], { type: 'image/jpeg' }));
    project.siteCaptures = [{
      id: captureId, label: 'Front', originalRef, workingRef, thumbnailRef,
      fileName: 'front.jpg', mimeType: 'image/jpeg', byteSize: 18,
      pixelWidth: 6000, pixelHeight: 4000, workingPixelWidth: 4096, workingPixelHeight: 2731,
      capturedAt: Date.now(), notes: '',
      referenceWall: { wallName: 'Front wall', widthMm: 12000, heightMm: 6000, planeDepthMm: 0, planeDepthDirection: 'behind', referencePlaneName: 'Front wall', method: 'laser', notes: '' },
    }];
    mocks.getDownloadURL.mockImplementation(async (ref: any) => `https://storage.example/${ref.path}`);

    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('cloud');
    expect(mocks.transactionSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteCaptures: [expect.objectContaining({
        originalRef: expect.stringContaining('/captures/'),
        workingRef: expect.stringContaining('/captures/'),
        thumbnailRef: expect.stringContaining('/captures/'),
      })],
    }));
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('round-trips site-capture files through clone-safe bytes', async () => {
    const projectId = `asset-${Date.now()}`;
    const ref = makeSiteCaptureAssetRef(projectId, 'capture-1', 'original');
    const original = new File(['camera-original'], 'camera.heic', { type: 'image/heic' });

    await putSiteCaptureAsset(ref, original);
    const restored = await getSiteCaptureAsset(ref);

    expect(restored).toBeInstanceOf(Blob);
    expect(restored?.type).toBe('image/heic');
    expect(await restored?.text()).toBe('camera-original');
    await StorageService.deleteProjectLocal(projectId);
  });
});
