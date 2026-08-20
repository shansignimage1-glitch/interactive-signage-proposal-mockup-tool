import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeProject } from '../fixtures/project';
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';

const readStateUpload = async (blob: Blob) => JSON.parse(
  blob.type === 'application/gzip'
    ? strFromU8(gunzipSync(new Uint8Array(await blob.arrayBuffer())))
    : await blob.text(),
);

const mocks = vi.hoisted(() => {
  const transactionSet = vi.fn();
  const getDoc = vi.fn();
  const getDownloadURL = vi.fn();
  const uploadBytes = vi.fn();
  const getBytes = vi.fn();
  const deleteDoc = vi.fn();
  const listAll = vi.fn(async (_ref: any) => ({ items: [], prefixes: [] }));
  const deleteObject = vi.fn();
  const uploadImage = vi.fn();
  const ensureReady = vi.fn();
  const connector = {
    id: 'google', available: true, isConnected: () => true, ensureReady,
    uploadImage, deleteImage: vi.fn(), deleteAllAppData: vi.fn(),
  };
  return {
    transactionSet, getDoc, getDownloadURL, uploadBytes, getBytes, deleteDoc, listAll, deleteObject, uploadImage, ensureReady, connector,
    uploadedObjects: new Map<string, Uint8Array>(),
    remoteExists: false, remoteRevision: 0, remoteStatePath: undefined as string | undefined,
    cloudDocs: [] as Array<{ data: () => any }>,
    cloudProject: null as any,
  };
});

vi.mock('../../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db, path) => ({ path })),
  where: vi.fn((...args) => args),
  query: vi.fn((...args) => args[0]),
  limit: vi.fn((value) => value),
  doc: vi.fn((_db, collectionName, id) => ({ collectionName, id })),
  getDoc: mocks.getDoc,
  getDocs: vi.fn(async () => ({ docs: mocks.cloudDocs, empty: mocks.cloudDocs.length === 0 })),
  deleteDoc: mocks.deleteDoc,
  setDoc: vi.fn(),
  runTransaction: vi.fn(async (_db, callback) => callback({
    get: vi.fn(async () => ({
      exists: () => mocks.remoteExists,
      data: () => ({ cloudRevision: mocks.remoteRevision, statePath: mocks.remoteStatePath }),
    })),
    set: mocks.transactionSet,
  })),
}));
vi.mock('firebase/storage', () => ({
  ref: vi.fn((_storage, path) => ({ path, name: path.split('/').pop() })),
  getDownloadURL: mocks.getDownloadURL,
  getBytes: mocks.getBytes,
  uploadBytes: mocks.uploadBytes,
  listAll: mocks.listAll,
  deleteObject: mocks.deleteObject,
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
    mocks.transactionSet.mockReset();
    mocks.uploadedObjects.clear();
    mocks.uploadBytes.mockImplementation(async (ref: any, value: Blob | Uint8Array) => {
      const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value);
      mocks.uploadedObjects.set(ref.path, bytes);
      return { ref };
    });
    mocks.getBytes.mockImplementation(async (ref: any) => {
      const bytes = mocks.uploadedObjects.get(ref.path);
      if (!bytes) throw new Error(`Missing mocked object ${ref.path}`);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    });
    mocks.deleteObject.mockImplementation(async (ref: any) => { mocks.uploadedObjects.delete(ref.path); });
    mocks.deleteDoc.mockResolvedValue(undefined);
    mocks.uploadImage.mockReset();
    mocks.getDownloadURL.mockReset();
    mocks.getDoc.mockImplementation(async () => ({ exists: () => !!mocks.cloudProject, data: () => mocks.cloudProject }));
    mocks.ensureReady.mockResolvedValue(true);
    mocks.remoteExists = false;
    mocks.remoteRevision = 0;
    mocks.remoteStatePath = undefined;
    mocks.cloudDocs = [];
    mocks.cloudProject = null;
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
    expect(mocks.uploadBytes).toHaveBeenCalledTimes(2);
    expect(mocks.transactionSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        schemaVersion: 2,
        statePath: expect.stringContaining('/projects/'),
      }),
    );
    const stateUpload = mocks.uploadBytes.mock.calls.find(([ref]) => ref.path.includes('/projects/'))!;
    const storedState = await readStateUpload(stateUpload[1] as Blob);
    expect(storedState.canvases[0].backgroundImage).toBe('https://storage.example/image-hash');
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('queues signed-in projects while offline and keeps the latest local copy', async () => {
    const project = makeProject({ projectId: `offline-${Date.now()}` });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('queued');
    const local = await StorageService.loadProjectLocal(project.projectId);
    expect(local).toEqual(expect.objectContaining({ ...project, lastSaved: expect.any(Number) }));
    expect(local!.lastSaved).toBeGreaterThan(project.lastSaved);
    expect(mocks.transactionSet).not.toHaveBeenCalled();
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('detects a newer cloud revision instead of overwriting another device', async () => {
    const project = makeProject({ projectId: `conflict-${Date.now()}`, cloudRevision: 2 });
    mocks.remoteExists = true;
    mocks.remoteRevision = 3;
    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('conflict');
    expect(mocks.transactionSet).not.toHaveBeenCalled();
    expect(mocks.listAll).not.toHaveBeenCalled();
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('keeps guest projects local and never touches cloud services', async () => {
    const project = makeProject({ projectId: `guest-${Date.now()}` });
    await expect(StorageService.saveProject('guest_test', project)).resolves.toBe('local');
    expect(mocks.transactionSet).not.toHaveBeenCalled();
    expect(mocks.uploadImage).not.toHaveBeenCalled();
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('merges cloud projects into the cross-device project list', async () => {
    const local = makeProject({ projectId: `local-list-${Date.now()}`, projectName: 'Desktop Draft', lastSaved: 100 });
    await StorageService.saveProjectLocal(local);
    mocks.cloudDocs = [{ data: () => ({ projectId: 'phone-project', projectName: 'Phone Survey', updatedAt: 200, canvases: [{}] }) }];

    const projects = await StorageService.listProjects('user-1');

    expect(projects.map(project => project.name)).toEqual(['Phone Survey', 'Desktop Draft']);
    await StorageService.deleteProjectLocal(local.projectId);
  });

  it('downloads a cloud-only phone project and caches it on desktop', async () => {
    const phoneProject = makeProject({ projectId: `phone-${Date.now()}`, projectName: 'Phone Survey', lastSaved: 100 });
    mocks.cloudProject = { ...phoneProject, userId: 'user-1', updatedAt: 250 };

    const loaded = await StorageService.loadProject('user-1', phoneProject.projectId);

    expect(loaded?.projectName).toBe('Phone Survey');
    expect(loaded?.lastSaved).toBe(250);
    expect((await StorageService.loadProjectLocal(phoneProject.projectId))?.projectName).toBe('Phone Survey');
    await StorageService.deleteProjectLocal(phoneProject.projectId);
  });

  it('opens a never-synced phone project without waiting for a missing cloud document', async () => {
    const local = makeProject({ projectId: `never-synced-${Date.now()}`, projectName: 'Xplore aviation', cloudRevision: 0 });
    await StorageService.saveProjectLocal(local);

    const loaded = await StorageService.loadProject('user-1', local.projectId);

    expect(loaded?.projectName).toBe('Xplore aviation');
    expect(mocks.getDoc).not.toHaveBeenCalled();
    expect(await StorageService.hasQueuedProjectSync('user-1', local.projectId)).toBe(true);
    await StorageService.deleteProjectLocal(local.projectId);
  });

  it('opens a clean cloud-backed local copy offline without marking it dirty', async () => {
    const local = makeProject({
      projectId: `offline-reopen-${Date.now()}`,
      projectName: 'Offline Xplore',
      cloudRevision: 4,
      user: { uid: 'user-1', displayName: 'Owner', email: null, photoURL: null },
    });
    await StorageService.saveProjectLocal(local);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });

    const loaded = await StorageService.loadProject('user-1', local.projectId);

    expect(loaded?.projectName).toBe('Offline Xplore');
    expect(mocks.getDoc).not.toHaveBeenCalled();
    expect(await StorageService.hasQueuedProjectSync('user-1', local.projectId)).toBe(false);
    await StorageService.deleteProjectLocal(local.projectId);
  });

  it('falls back to a clean cached cloud revision without queueing it when the cloud read fails', async () => {
    const local = makeProject({
      projectId: `cloud-read-fallback-${Date.now()}`,
      projectName: 'Cached Xplore',
      cloudRevision: 4,
      user: { uid: 'user-1', displayName: 'Owner', email: null, photoURL: null },
    });
    await StorageService.saveProjectLocal(local);
    mocks.getDoc.mockRejectedValueOnce(new Error('temporary Firestore channel failure'));

    const loaded = await StorageService.loadProject('user-1', local.projectId);

    expect(loaded?.projectName).toBe('Cached Xplore');
    expect(await StorageService.hasQueuedProjectSync('user-1', local.projectId)).toBe(false);
    await StorageService.deleteProjectLocal(local.projectId);
  });

  it('isolates another account local projects while allowing legacy phone drafts to be adopted', async () => {
    const otherAccount = makeProject({
      projectId: `other-owner-${Date.now()}`,
      projectName: 'Private account A project',
      user: { uid: 'user-a', displayName: 'A', email: null, photoURL: null },
      cloudRevision: 0,
    });
    const legacyGuest = makeProject({
      projectId: `legacy-guest-${Date.now()}`,
      projectName: 'Legacy phone draft',
      user: { uid: 'guest_old_phone', displayName: 'Guest', email: null, photoURL: null },
      cloudRevision: 0,
    });
    await StorageService.saveProjectLocal(otherAccount);
    await StorageService.saveProjectLocal(legacyGuest);

    const listed = await StorageService.listProjects('user-b');
    expect(listed.map(project => project.id)).not.toContain(otherAccount.projectId);
    expect(listed.map(project => project.id)).toContain(legacyGuest.projectId);
    await expect(StorageService.loadProject('user-b', otherAccount.projectId)).resolves.toBeNull();
    await expect(StorageService.loadProject('user-b', legacyGuest.projectId)).resolves.toEqual(legacyGuest);
    expect(await StorageService.hasQueuedProjectSync('user-b', otherAccount.projectId)).toBe(false);
    expect(await StorageService.hasQueuedProjectSync('user-b', legacyGuest.projectId)).toBe(true);

    await StorageService.deleteProjectLocal(otherAccount.projectId);
    await StorageService.deleteProjectLocal(legacyGuest.projectId);
  });

  it('round-trips an Xplore-sized project through Storage while Firestore stays a small index', async () => {
    const project = makeProject({ projectId: `xplore-${Date.now()}`, projectName: 'Xplore aviation' });
    const contour = Array.from({ length: 30_000 }, (_, index) => ({ x: index, y: index % 500 }));
    project.canvases[0].signs = [{
      id: 'sign-1', name: 'Detected fascia', image: '',
      corners: [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 260 }, { x: 0, y: 260 }],
      signType: 'fascia_non_ill', extrusionEnabled: true, extrusionDepth: 15,
      extrusionAngle: 45, opacity: 1, blendMode: 'normal', sideColor: '#1e3a8a',
      elements: [{ id: 'letters', name: 'Letters', enabled: true, depth: 15, contours: [contour] }],
    }];

    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('cloud');
    const index = mocks.transactionSet.mock.calls[0][1];
    expect(index).toEqual(expect.objectContaining({
      projectName: 'Xplore aviation', schemaVersion: 2,
      statePath: expect.stringContaining('/projects/'),
    }));
    expect(index.canvases).toBeUndefined();
    expect(Object.values(index)).not.toContain(undefined);
    expect(JSON.stringify(index).length).toBeLessThan(2_000);

    mocks.cloudProject = index;
    const restored = await StorageService.loadProjectCloud('user-1', project.projectId);
    expect(restored?.projectName).toBe('Xplore aviation');
    expect(restored?.canvases[0].signs[0].elements?.[0].contours[0]).toHaveLength(contour.length);
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('serializes overlapping cloud saves while keeping the newest phone edit locally durable', async () => {
    const projectId = `overlap-${Date.now()}`;
    const first = makeProject({ projectId, notes: 'first edit', cloudRevision: 0 });
    const second = { ...first, notes: 'newest edit' };
    let releaseFirstUpload!: () => void;
    let markFirstUploadStarted!: () => void;
    const firstUploadStarted = new Promise<void>(resolve => { markFirstUploadStarted = resolve; });
    const firstUploadGate = new Promise<void>(resolve => { releaseFirstUpload = resolve; });
    let stateUploadCount = 0;
    let activeStateUploads = 0;
    let maxActiveStateUploads = 0;
    mocks.transactionSet.mockImplementation((_ref: any, index: any) => {
      mocks.remoteExists = true;
      mocks.remoteRevision = index.cloudRevision;
      mocks.remoteStatePath = index.statePath;
    });
    mocks.uploadBytes.mockImplementation(async (ref: any, value: Blob | Uint8Array) => {
      if (ref.path.includes('/projects/')) {
        stateUploadCount += 1;
        activeStateUploads += 1;
        maxActiveStateUploads = Math.max(maxActiveStateUploads, activeStateUploads);
        if (stateUploadCount === 1) {
          markFirstUploadStarted();
          await firstUploadGate;
        }
      }
      const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value);
      mocks.uploadedObjects.set(ref.path, bytes);
      if (ref.path.includes('/projects/')) activeStateUploads -= 1;
      return { ref };
    });

    const firstSave = StorageService.saveProject('user-overlap', first);
    await firstUploadStarted;
    const secondSave = StorageService.saveProject('user-overlap', second);
    await vi.waitFor(async () => {
      expect((await StorageService.loadProjectLocal(projectId))?.notes).toBe('newest edit');
    });
    releaseFirstUpload();

    await expect(Promise.all([firstSave, secondSave])).resolves.toEqual(['local', 'cloud']);
    expect(maxActiveStateUploads).toBe(1);
    expect(mocks.transactionSet.mock.calls.map(([, index]) => index.cloudRevision)).toEqual([1]);
    const committedIndex = mocks.transactionSet.mock.calls[0][1];
    expect(await readStateUpload(new Blob([mocks.uploadedObjects.get(committedIndex.statePath)!], { type: 'application/gzip' })))
      .toEqual(expect.objectContaining({ notes: 'newest edit' }));
    expect([...mocks.uploadedObjects.keys()].filter(path => path.includes('/projects/'))).toHaveLength(1);
    expect((await StorageService.loadProjectLocal(projectId))?.notes).toBe('newest edit');
    await StorageService.deleteProjectLocal(projectId);
  });

  it('preserves invocation order when the older IndexedDB write is delayed', async () => {
    const projectId = `local-order-${Date.now()}`;
    const older = makeProject({ projectId, notes: 'older snapshot', cloudRevision: 0 });
    const newer = { ...older, notes: 'newer snapshot' };
    const originalSaveLocal = StorageService.saveProjectLocal.bind(StorageService);
    let releaseOlder!: () => void;
    let markOlderStarted!: () => void;
    const olderStarted = new Promise<void>(resolve => { markOlderStarted = resolve; });
    const olderGate = new Promise<void>(resolve => { releaseOlder = resolve; });
    const localSpy = vi.spyOn(StorageService, 'saveProjectLocal').mockImplementation(async state => {
      if (state.projectId === projectId && state.notes === 'older snapshot') {
        markOlderStarted();
        await olderGate;
      }
      await originalSaveLocal(state);
    });
    mocks.transactionSet.mockImplementation((_ref: any, index: any) => {
      mocks.remoteExists = true;
      mocks.remoteRevision = index.cloudRevision;
      mocks.remoteStatePath = index.statePath;
    });

    try {
      const olderSave = StorageService.saveProject('user-1', older);
      await olderStarted;
      const newerSave = StorageService.saveProject('user-1', newer);
      releaseOlder();
      const results = await Promise.all([olderSave, newerSave]);
      expect(['local', 'cloud']).toContain(results[0]);
      expect(results[1]).toBe('cloud');

      expect((await StorageService.loadProjectLocal(projectId))?.notes).toBe('newer snapshot');
      const committedIndex = mocks.transactionSet.mock.calls.at(-1)![1];
      expect(await readStateUpload(new Blob([mocks.uploadedObjects.get(committedIndex.statePath)!], { type: 'application/gzip' })))
        .toEqual(expect.objectContaining({ notes: 'newer snapshot' }));
    } finally {
      localSpy.mockRestore();
      await StorageService.deleteProjectLocal(projectId);
    }
  });

  it('does not let an in-flight save recreate a deleted project', async () => {
    const projectId = `delete-race-${Date.now()}`;
    const project = makeProject({ projectId, notes: 'must stay deleted' });
    const originalSaveLocal = StorageService.saveProjectLocal.bind(StorageService);
    let releaseLocal!: () => void;
    let markLocalStarted!: () => void;
    const localStarted = new Promise<void>(resolve => { markLocalStarted = resolve; });
    const localGate = new Promise<void>(resolve => { releaseLocal = resolve; });
    const localSpy = vi.spyOn(StorageService, 'saveProjectLocal').mockImplementation(async state => {
      if (state.projectId === projectId) {
        markLocalStarted();
        await localGate;
      }
      await originalSaveLocal(state);
    });

    try {
      const save = StorageService.saveProject('user-delete-race', project);
      await localStarted;
      const deletion = StorageService.deleteProjectCloud('user-delete-race', projectId);
      releaseLocal();

      await expect(save).resolves.toBe('error');
      await expect(deletion).resolves.toBeUndefined();
      expect(mocks.transactionSet).not.toHaveBeenCalled();
      await StorageService.deleteProjectLocal(projectId);
      await expect(StorageService.saveProject('user-delete-race', project)).resolves.toBe('error');
      expect(await StorageService.loadProjectLocal(projectId)).toBeFalsy();
    } finally {
      localSpy.mockRestore();
      await StorageService.deleteProjectLocal(projectId);
    }
  });

  it('queues a project after an online cloud failure and flushes it without a browser online event', async () => {
    const project = makeProject({ projectId: `retry-${Date.now()}`, projectName: 'Xplore aviation' });
    mocks.uploadBytes.mockRejectedValueOnce(new Error('temporary Firebase outage'));

    await expect(StorageService.saveProject('user-retry', project)).resolves.toBe('queued');

    mocks.uploadBytes.mockImplementation(async (ref: any, value: Blob | Uint8Array) => {
      const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : new Uint8Array(value);
      mocks.uploadedObjects.set(ref.path, bytes);
      return { ref };
    });
    await expect(StorageService.flushSyncQueue('user-retry')).resolves.toBe(1);
    expect(mocks.transactionSet).toHaveBeenCalledOnce();
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('rebases a newer queued revision-zero edit onto the existing cloud revision after reload', async () => {
    const project = makeProject({
      projectId: `queued-rebase-${Date.now()}`,
      projectName: 'Xplore aviation',
      notes: 'newer iPhone note',
      cloudRevision: 0,
    });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('queued');
    const queuedLocal = (await StorageService.loadProjectLocal(project.projectId))!;

    mocks.remoteExists = true;
    mocks.remoteRevision = 1;
    mocks.cloudProject = {
      schemaVersion: 2,
      userId: 'user-1',
      projectId: project.projectId,
      projectName: project.projectName,
      updatedAt: queuedLocal.lastSaved - 1,
      lastSaved: queuedLocal.lastSaved - 1,
      cloudRevision: 1,
      statePath: 'users/user-1/projects/existing/revisions/1.json.gz',
    };
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });

    await expect(StorageService.flushSyncQueue('user-1')).resolves.toBe(1);

    expect(mocks.transactionSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      cloudRevision: 2,
      projectId: project.projectId,
    }));
    expect((await StorageService.loadProjectLocal(project.projectId))?.notes).toBe('newer iPhone note');
    expect((await StorageService.loadProjectLocal(project.projectId))?.cloudRevision).toBe(2);
    expect(await StorageService.hasQueuedProjectSync('user-1', project.projectId)).toBe(false);
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('does not rebase a queued stale revision over newer cloud data based on device time', async () => {
    const project = makeProject({
      projectId: `clock-skew-conflict-${Date.now()}`,
      projectName: 'Tablet cached copy',
      notes: 'stale tablet contents',
      cloudRevision: 2,
    });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('queued');
    const queuedLocal = (await StorageService.loadProjectLocal(project.projectId))!;

    mocks.cloudProject = {
      schemaVersion: 2,
      userId: 'user-1',
      projectId: project.projectId,
      projectName: project.projectName,
      // Simulate the stale device clock being ahead of the newer cloud write.
      updatedAt: queuedLocal.lastSaved - 1,
      lastSaved: queuedLocal.lastSaved - 1,
      cloudRevision: 3,
      statePath: 'users/user-1/projects/newer/revisions/3.json.gz',
    };
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });

    await expect(StorageService.flushSyncQueue('user-1')).resolves.toBe(0);

    expect(mocks.transactionSet).not.toHaveBeenCalled();
    expect(await StorageService.hasQueuedProjectSync('user-1', project.projectId)).toBe(true);
    expect(StorageService.hasProjectSyncConflict('user-1', project.projectId)).toBe(true);
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('does not delete project state when the authoritative Firestore delete fails', async () => {
    mocks.deleteDoc.mockRejectedValueOnce(new Error('temporary Firestore outage'));

    await expect(StorageService.deleteProjectCloud('user-delete', 'project-1')).rejects.toThrow('temporary Firestore outage');

    expect(mocks.listAll).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
  });

  it('reuses the Firestore index returned by the project list when opening a cloud project', async () => {
    const project = makeProject({ projectId: `listed-${Date.now()}`, projectName: 'Xplore aviation' });
    const statePath = `users/user-1/projects/${project.projectId}/revisions/1.json.gz`;
    mocks.uploadedObjects.set(statePath, gzipSync(strToU8(JSON.stringify(project))));
    const index = {
      schemaVersion: 2,
      statePath,
      stateEncoding: 'gzip',
      userId: 'user-1',
      projectId: project.projectId,
      projectName: project.projectName,
      updatedAt: project.lastSaved,
      lastSaved: project.lastSaved,
      cloudRevision: 1,
      canvasCount: project.canvases.length,
    };
    mocks.cloudDocs = [{ data: () => index }];

    await expect(StorageService.listProjectsCloud('user-1')).resolves.toEqual([
      expect.objectContaining({ id: project.projectId, name: 'Xplore aviation' }),
    ]);
    mocks.getDoc.mockClear();

    const restored = await StorageService.loadProjectCloud('user-1', project.projectId);

    expect(restored?.projectName).toBe('Xplore aviation');
    expect(mocks.getDoc).not.toHaveBeenCalled();
  });

  it('refreshes an aged-out cached project pointer after another device saves', async () => {
    const project = makeProject({ projectId: `refresh-${Date.now()}`, projectName: 'Fresh Xplore' });
    const stalePath = `users/user-1/projects/${project.projectId}/revisions/stale.json.gz`;
    const freshPath = `users/user-1/projects/${project.projectId}/revisions/fresh.json.gz`;
    const staleIndex = {
      schemaVersion: 2, statePath: stalePath, stateEncoding: 'gzip', userId: 'user-1',
      projectId: project.projectId, projectName: 'Stale Xplore', updatedAt: 1, cloudRevision: 1,
    };
    const freshIndex = { ...staleIndex, statePath: freshPath, projectName: project.projectName, updatedAt: 2, cloudRevision: 2 };
    mocks.cloudDocs = [{ data: () => staleIndex }];
    mocks.cloudProject = freshIndex;
    mocks.uploadedObjects.set(freshPath, gzipSync(strToU8(JSON.stringify(project))));
    await StorageService.listProjectsCloud('user-1');
    mocks.getDoc.mockClear();

    const restored = await StorageService.loadProjectCloud('user-1', project.projectId);

    expect(restored?.projectName).toBe('Fresh Xplore');
    expect(restored?.cloudRevision).toBe(2);
    expect(mocks.getDoc).toHaveBeenCalledOnce();
  });

  it('refreshes a valid retained revision on the next selection instead of staying stale', async () => {
    const projectId = `valid-stale-${Date.now()}`;
    const staleState = makeProject({ projectId, projectName: 'Stale Xplore', notes: 'revision one', cloudRevision: 1, lastSaved: 1 });
    const freshState = makeProject({ projectId, projectName: 'Fresh Xplore', notes: 'revision two', cloudRevision: 2, lastSaved: 2 });
    const stalePath = `users/user-1/projects/${projectId}/revisions/1.json.gz`;
    const freshPath = `users/user-1/projects/${projectId}/revisions/2.json.gz`;
    const staleIndex = {
      schemaVersion: 2, statePath: stalePath, stateEncoding: 'gzip', userId: 'user-1',
      projectId, projectName: staleState.projectName, updatedAt: 1, lastSaved: 1, cloudRevision: 1,
    };
    const freshIndex = {
      ...staleIndex, statePath: freshPath, projectName: freshState.projectName,
      updatedAt: 2, lastSaved: 2, cloudRevision: 2,
    };
    mocks.uploadedObjects.set(stalePath, gzipSync(strToU8(JSON.stringify(staleState))));
    mocks.uploadedObjects.set(freshPath, gzipSync(strToU8(JSON.stringify(freshState))));
    mocks.cloudDocs = [{ data: () => staleIndex }];
    await StorageService.listProjectsCloud('user-1');

    const firstOpen = await StorageService.loadProjectCloud('user-1', projectId);
    expect(firstOpen?.notes).toBe('revision one');
    expect(mocks.getDoc).not.toHaveBeenCalled();

    mocks.cloudProject = freshIndex;
    const secondOpen = await StorageService.loadProjectCloud('user-1', projectId);

    expect(secondOpen?.projectName).toBe('Fresh Xplore');
    expect(secondOpen?.notes).toBe('revision two');
    expect(secondOpen?.cloudRevision).toBe(2);
    expect(mocks.getDoc).toHaveBeenCalledOnce();
  });

  it('falls back to authenticated Storage when a saved download URL is stale', async () => {
    const project = makeProject({ projectId: `url-fallback-${Date.now()}`, projectName: 'Xplore aviation' });
    const statePath = `users/user-1/projects/${project.projectId}/revisions/current.json.gz`;
    mocks.uploadedObjects.set(statePath, gzipSync(strToU8(JSON.stringify(project))));
    mocks.cloudProject = {
      schemaVersion: 2, statePath, stateUrl: 'https://expired.example/state', stateEncoding: 'gzip',
      userId: 'user-1', projectId: project.projectId, projectName: project.projectName,
      updatedAt: project.lastSaved, cloudRevision: 1,
    };
    const fetchMock = vi.fn().mockRejectedValue(new Error('expired token'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const restored = await StorageService.loadProjectCloud('user-1', project.projectId);
      expect(restored?.projectName).toBe('Xplore aviation');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(mocks.getBytes).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uploads primary and supporting site-capture photos and stores only cloud references in Firestore', async () => {
    const project = makeProject({ projectId: `capture-${Date.now()}` });
    const captureId = 'capture-1';
    const supportingId = 'capture-1-supporting-1';
    const originalRef = makeSiteCaptureAssetRef(project.projectId, captureId, 'original');
    const workingRef = makeSiteCaptureAssetRef(project.projectId, captureId, 'working');
    const thumbnailRef = makeSiteCaptureAssetRef(project.projectId, captureId, 'thumbnail');
    await putSiteCaptureAsset(originalRef, new Blob(['untouched-original'], { type: 'image/jpeg' }));
    await putSiteCaptureAsset(workingRef, new Blob(['working'], { type: 'image/jpeg' }));
    await putSiteCaptureAsset(thumbnailRef, new Blob(['thumb'], { type: 'image/jpeg' }));
    const supportingOriginalRef = makeSiteCaptureAssetRef(project.projectId, supportingId, 'original');
    const supportingWorkingRef = makeSiteCaptureAssetRef(project.projectId, supportingId, 'working');
    const supportingThumbnailRef = makeSiteCaptureAssetRef(project.projectId, supportingId, 'thumbnail');
    await putSiteCaptureAsset(supportingOriginalRef, new Blob(['supporting-original'], { type: 'image/jpeg' }));
    await putSiteCaptureAsset(supportingWorkingRef, new Blob(['supporting-working'], { type: 'image/jpeg' }));
    await putSiteCaptureAsset(supportingThumbnailRef, new Blob(['supporting-thumb'], { type: 'image/jpeg' }));
    project.siteCaptures = [{
      id: captureId, label: 'Front', originalRef, workingRef, thumbnailRef,
      fileName: 'front.jpg', mimeType: 'image/jpeg', byteSize: 18,
      pixelWidth: 6000, pixelHeight: 4000, workingPixelWidth: 4096, workingPixelHeight: 2731,
      capturedAt: Date.now(), notes: '',
      supportingPhotos: [{
        id: supportingId, originalRef: supportingOriginalRef, workingRef: supportingWorkingRef, thumbnailRef: supportingThumbnailRef,
        fileName: 'front-detail.jpg', mimeType: 'image/jpeg', byteSize: 18,
        pixelWidth: 3000, pixelHeight: 2000, workingPixelWidth: 3000, workingPixelHeight: 2000,
        capturedAt: Date.now(),
      }],
      referenceWall: { wallName: 'Front wall', widthMm: 12000, heightMm: 6000, planeDepthMm: 0, planeDepthDirection: 'behind', referencePlaneName: 'Front wall', method: 'laser', notes: '' },
    }];
    mocks.getDownloadURL.mockImplementation(async (ref: any) => `https://storage.example/${ref.path}`);

    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('cloud');
    expect(mocks.transactionSet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      schemaVersion: 2,
      statePath: expect.stringContaining('/projects/'),
    }));
    const stateUpload = mocks.uploadBytes.mock.calls.find(([ref]) => ref.path.includes('/projects/'))!;
    const storedState = await readStateUpload(stateUpload[1] as Blob);
    expect(storedState).toEqual(expect.objectContaining({
      siteCaptures: [expect.objectContaining({
        originalRef: expect.stringContaining('/captures/'),
        workingRef: expect.stringContaining('/captures/'),
        thumbnailRef: expect.stringContaining('/captures/'),
        supportingPhotos: [expect.objectContaining({
          originalRef: expect.stringContaining(supportingId),
          workingRef: expect.stringContaining(supportingId),
          thumbnailRef: expect.stringContaining(supportingId),
        })],
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

  it('removes primary and supporting local photo assets only after the project revision is saved', async () => {
    const project = makeProject({ projectId: `capture-delete-local-${Date.now()}` });
    const primaryId = 'front';
    const supportingId = 'front-detail';
    const primaryRef = makeSiteCaptureAssetRef(project.projectId, primaryId, 'original');
    const supportingRef = makeSiteCaptureAssetRef(project.projectId, supportingId, 'thumbnail');
    project.siteCaptures = [{
      id: primaryId, label: 'Front', originalRef: primaryRef, workingRef: primaryRef, thumbnailRef: primaryRef,
      fileName: 'front.jpg', mimeType: 'image/jpeg', byteSize: 5, pixelWidth: 10, pixelHeight: 10,
      workingPixelWidth: 10, workingPixelHeight: 10, capturedAt: Date.now(), notes: '',
      supportingPhotos: [{
        id: supportingId, originalRef: supportingRef, workingRef: supportingRef, thumbnailRef: supportingRef,
        fileName: 'detail.jpg', mimeType: 'image/jpeg', byteSize: 6, pixelWidth: 10, pixelHeight: 10,
        workingPixelWidth: 10, workingPixelHeight: 10, capturedAt: Date.now(),
      }],
      referenceWall: { wallName: 'Front', planeDepthMm: 0, planeDepthDirection: 'behind', referencePlaneName: 'Front', method: 'laser', notes: '' },
    }];
    await putSiteCaptureAsset(primaryRef, new Blob(['front'], { type: 'image/jpeg' }));
    await putSiteCaptureAsset(supportingRef, new Blob(['detail'], { type: 'image/jpeg' }));
    await StorageService.saveProjectLocal(project);

    await StorageService.saveProjectLocal({ ...project, siteCaptures: [], lastSaved: Date.now() + 1 });

    expect((await StorageService.loadProjectLocal(project.projectId))?.siteCaptures).toEqual([]);
    expect(await getSiteCaptureAsset(primaryRef)).toBeNull();
    expect(await getSiteCaptureAsset(supportingRef)).toBeNull();
    await StorageService.deleteProjectLocal(project.projectId);
  });

  it('never deletes shared cloud photo paths while saving a newer project revision', async () => {
    const project = makeProject({ projectId: `capture-delete-cloud-${Date.now()}` });
    mocks.remoteExists = true;

    await expect(StorageService.saveProject('user-1', project)).resolves.toBe('cloud');

    expect(mocks.transactionSet).toHaveBeenCalledOnce();
    expect(mocks.listAll).not.toHaveBeenCalled();
    expect(mocks.deleteObject).not.toHaveBeenCalled();
    await StorageService.deleteProjectLocal(project.projectId);
  });
});
