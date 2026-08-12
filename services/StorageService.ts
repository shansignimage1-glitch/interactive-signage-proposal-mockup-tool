
import { db, storage } from '../firebase';
import { collection, deleteDoc, doc, getDoc, getDocs, limit, query, runTransaction, setDoc, where } from 'firebase/firestore';
import { deleteObject, getDownloadURL, listAll, ref as storageRef, uploadBytes, type StorageReference } from 'firebase/storage';
import { MockupState, ProjectMetadata } from '../types';
import { hashDataUri, dataUriToBlob } from './imageHash';
import { connectors, getActiveConnector, getConnectorForRef } from './driveConnectors';
import { getKnownRef, recordKnownRef, resolveProjectImages, ResolveResult, isDriveRef } from './AssetResolver';
import { reportError, reportWarning } from './monitoring';
import { assertStorageCapacity, optimizeDataUri } from './imageProcessing';

const FIRESTORE_COLLECTION = 'projects';
const DB_NAME = 'SignageProDB';
const STORE_PROJECTS = 'projects';
const STORE_METADATA = 'metadata';
const STORE_ASSETS = 'assets'; // cached cloud-drive image blobs, keyed by ref
const STORE_SYNC_QUEUE = 'syncQueue';
const DB_VERSION = 4; // Site-capture blobs reuse the existing durable assets store.
const knownCloudRevisions = new Map<string, number>();
const revisionKey = (userId: string, projectId: string) => `${userId}_${projectId}`;

// --- IndexedDB Wrapper ---

// Cached promise — only one DB connection opened for the lifetime of the page
let _dbPromise: Promise<IDBDatabase> | null = null;

const initDB = (): Promise<IDBDatabase> => {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      _dbPromise = null; // allow retry on next call
      reject(request.error);
    };
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Store for full project data (JSON)
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'projectId' });
      }

      // Store for lightweight metadata (Lists)
      if (!db.objectStoreNames.contains(STORE_METADATA)) {
        db.createObjectStore(STORE_METADATA, { keyPath: 'id' });
      }

      // v3: cache of images fetched from the user's cloud drive, so projects
      // open instantly (and offline) after the first fetch
      if (!db.objectStoreNames.contains(STORE_ASSETS)) {
        db.createObjectStore(STORE_ASSETS, { keyPath: 'ref' });
      }
      if (!db.objectStoreNames.contains(STORE_SYNC_QUEUE)) {
        db.createObjectStore(STORE_SYNC_QUEUE, { keyPath: 'projectId' });
      }
    };
  });

  return _dbPromise;
};

const idbOperation = async <T>(
    storeName: string, 
    mode: IDBTransactionMode, 
    operation: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T> => {
    const db = await initDB();
    return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = operation(store);
        
        if (req) {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } else {
             tx.oncomplete = () => resolve(undefined as unknown as T);
             tx.onerror = () => reject(tx.error);
        }
    });
};

// --- Cloud-drive asset cache (IndexedDB 'assets' store) ---

export interface CachedAsset { ref: string; blob: Blob; mime: string; cachedAt: number }
interface StoredCachedAsset {
    ref: string;
    blob?: Blob; // Legacy v3/v4 records.
    bytes?: ArrayBuffer;
    mime: string;
    cachedAt: number;
}

export const getCachedAsset = async (ref: string): Promise<CachedAsset | null> => {
    const stored = (await idbOperation<StoredCachedAsset>(STORE_ASSETS, 'readonly', store => store.get(ref))) ?? null;
    if (!stored) return null;
    if (stored.blob instanceof Blob) return { ...stored, blob: stored.blob };
    if (stored.bytes) return { ...stored, blob: new Blob([stored.bytes], { type: stored.mime }) };
    return null;
};

export const putCachedAsset = async (ref: string, blob: Blob): Promise<void> => {
    // WebKit can reject Blob/File objects during IndexedDB structured cloning
    // with "Error preparing Blob/File data". ArrayBuffer is consistently
    // cloneable across Safari, Chromium and Firefox; reconstruct the Blob only
    // when a consumer reads it back. Existing Blob records remain readable.
    const bytes = await blob.arrayBuffer();
    await idbOperation(STORE_ASSETS, 'readwrite', (store) =>
        store.put({ ref, bytes, mime: blob.type, cachedAt: Date.now() } as StoredCachedAsset));
};

export type SiteCaptureAssetKind = 'original' | 'working' | 'thumbnail' | 'dictation';
const SITE_CAPTURE_SCHEME = 'site-capture://';

export const makeSiteCaptureAssetRef = (projectId: string, captureId: string, kind: SiteCaptureAssetKind): string =>
    `${SITE_CAPTURE_SCHEME}${projectId}/${captureId}/${kind}`;

export const putSiteCaptureAsset = async (ref: string, blob: Blob): Promise<void> => {
    if (!ref.startsWith(SITE_CAPTURE_SCHEME)) throw new Error('Invalid site-capture asset reference.');
    await assertStorageCapacity(blob.size);
    await putCachedAsset(ref, blob);
};

export const getSiteCaptureAsset = async (ref: string): Promise<Blob | null> => {
    if (!ref.startsWith(SITE_CAPTURE_SCHEME)) return null;
    return (await getCachedAsset(ref))?.blob ?? null;
};

export const deleteSiteCaptureAssets = async (projectId: string, captureId?: string): Promise<void> => {
    const prefix = `${SITE_CAPTURE_SCHEME}${projectId}/${captureId ? `${captureId}/` : ''}`;
    const assets = await idbOperation<CachedAsset[]>(STORE_ASSETS, 'readonly', store => store.getAll());
    const refs = assets.filter(asset => asset.ref.startsWith(prefix)).map(asset => asset.ref);
    if (!refs.length) return;
    const db = await initDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        refs.forEach(ref => tx.objectStore(STORE_ASSETS).delete(ref));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
};

const uploadSiteCaptureAsset = async (userId: string, projectId: string, captureId: string, kind: SiteCaptureAssetKind, ref: string): Promise<string> => {
    if (!ref.startsWith(SITE_CAPTURE_SCHEME)) return ref;
    const asset = await getSiteCaptureAsset(ref);
    if (!asset) throw new Error(`Site-capture ${kind} is missing from this device.`);
    const destination = storageRef(storage, `users/${userId}/captures/${projectId}/${captureId}/${kind}`);
    try { return await getDownloadURL(destination); }
    catch {
        await uploadBytes(destination, asset, { contentType: asset.type || undefined });
        return getDownloadURL(destination);
    }
};

const deleteStorageTree = async (root: StorageReference): Promise<void> => {
    const listing = await listAll(root);
    await Promise.all(listing.items.map(deleteObject));
    await Promise.all(listing.prefixes.map(deleteStorageTree));
};

// --- Cloud Image Upload Helpers ---
// Firestore documents cap out at 1MB, so base64 images can't be stored inline.
// Images are uploaded to Firebase Storage (content-addressed by SHA-256 hash)
// and only their download URL syncs to Firestore. Content-addressing means
// repeated autosaves of an unchanged image never re-upload it — a cheap
// getDownloadURL() 404 check replaces the upload entirely.

// Resolves a possibly-base64 image to a stable, hosted URL. Non-data: URLs
// (already hosted images) pass through untouched.
const uploadImageIfNeeded = async (userId: string, dataUri: string): Promise<string> => {
    if (!dataUri || !dataUri.startsWith('data:')) return dataUri;

    const hash = await hashDataUri(dataUri);
    const imageRef = storageRef(storage, `users/${userId}/images/${hash}`);

    try {
        return await getDownloadURL(imageRef);
    } catch {
        // Not uploaded yet
        await uploadBytes(imageRef, dataUriToBlob(dataUri));
        return await getDownloadURL(imageRef);
    }
};

// Recovers the storage path's last segment (the content hash) from a Firebase
// Storage download URL — the inverse of the `users/{userId}/images/{hash}` path
// used above. Used to figure out which uploaded images are still referenced.
const extractImageHash = (url: string): string | null => {
    const match = /\/o\/(.+?)\?/.exec(url);
    if (!match) return null;
    return decodeURIComponent(match[1]).split('/').pop() ?? null;
};

// Gathers every cloud-drive ref ("gdrive://...") in a project document. Used
// for drive-side cleanup when a project is deleted.
const collectDriveRefs = (d: any): string[] => {
    const refs: string[] = [];
    const track = (v?: string | null) => { if (isDriveRef(v)) refs.push(v); };
    track(d?.titleBlock?.logoImage);
    (d?.referenceImages ?? []).forEach((r: any) => track(r?.image));
    (d?.canvases ?? []).forEach((canvas: any) => {
        track(canvas?.backgroundImage);
        (canvas?.signs ?? []).forEach((sign: any) => track(sign?.image));
    });
    return refs;
};

// Deletes any image under this user's Storage folder that's no longer
// referenced by any of their remaining cloud projects. Images are shared
// (content-addressed) across all of a user's projects, so this is the only
// safe time to delete one — never on every save, only after something that
// can orphan a reference (a project delete).
// Drive refs ("gdrive://...") are naturally ignored here: extractImageHash
// only matches Firebase Storage URLs, and only the Firebase bucket is listed.
const pruneOrphanedImages = async (userId: string): Promise<void> => {
    const snapshot = await getDocs(query(collection(db, FIRESTORE_COLLECTION), where('userId', '==', userId)));

    const referenced = new Set<string>();
    const track = (url?: string | null) => {
        const hash = url ? extractImageHash(url) : null;
        if (hash) referenced.add(hash);
    };

    snapshot.docs.forEach(doc => {
        const d = doc.data();
        track(d.titleBlock?.logoImage);
        (d.referenceImages ?? []).forEach((r: any) => track(r?.image));
        (d.canvases ?? []).forEach((canvas: any) => {
            track(canvas.backgroundImage);
            (canvas.signs ?? []).forEach((sign: any) => track(sign.image));
        });
    });

    const { items } = await listAll(storageRef(storage, `users/${userId}/images`));
    await Promise.all(items.map(item => {
        if (referenced.has(item.name)) return Promise.resolve();
        return deleteObject(item).catch(e => console.warn(`Failed to prune orphaned image ${item.name}:`, e));
    }));
};

export const StorageService = {
  
  // --- Local Project Management (IndexedDB) ---

  saveProjectLocal: async (state: MockupState, thumbnail?: string): Promise<void> => {
      const { projectId, projectName, lastSaved } = state;
      const metadata: ProjectMetadata = {
          id: projectId,
          name: projectName,
          lastModified: lastSaved,
          canvasCount: state.canvases.length,
          thumbnail: thumbnail || undefined
      };

      await assertStorageCapacity(new Blob([JSON.stringify(state)]).size);
      // Save Full Data
      await idbOperation(STORE_PROJECTS, 'readwrite', (store) => store.put(state));
      // Save Metadata
      await idbOperation(STORE_METADATA, 'readwrite', (store) => store.put(metadata));
  },

  loadProjectLocal: async (projectId: string): Promise<MockupState | null> => {
      return await idbOperation<MockupState>(STORE_PROJECTS, 'readonly', (store) => store.get(projectId));
  },

  listProjectsLocal: async (): Promise<ProjectMetadata[]> => {
      return await idbOperation<ProjectMetadata[]>(STORE_METADATA, 'readonly', (store) => store.getAll());
  },

  deleteProjectLocal: async (projectId: string): Promise<void> => {
      await idbOperation(STORE_PROJECTS, 'readwrite', (store) => store.delete(projectId));
      await idbOperation(STORE_METADATA, 'readwrite', (store) => store.delete(projectId));
      await deleteSiteCaptureAssets(projectId);
  },

  deleteSiteCapture: async (userId: string, projectId: string, captureId: string): Promise<void> => {
      await deleteSiteCaptureAssets(projectId, captureId);
      if (!userId.startsWith('guest_')) {
          await deleteStorageTree(storageRef(storage, `users/${userId}/captures/${projectId}/${captureId}`)).catch(error => {
              reportWarning('capture-delete', 'Cloud capture cleanup failed', { projectId, captureId, error: String(error) });
          });
      }
  },

  queueProjectSync: async (userId: string, projectId: string): Promise<void> => {
      await idbOperation(STORE_SYNC_QUEUE, 'readwrite', store => store.put({ projectId, userId, queuedAt: Date.now() }));
  },

  flushSyncQueue: async (userId: string): Promise<number> => {
      if (!navigator.onLine || userId.startsWith('guest_')) return 0;
      const jobs = await idbOperation<Array<{ projectId: string; userId: string }>>(STORE_SYNC_QUEUE, 'readonly', store => store.getAll());
      let completed = 0;
      for (const job of jobs.filter(item => item.userId === userId)) {
          const project = await StorageService.loadProjectLocal(job.projectId);
          if (!project) {
              await idbOperation(STORE_SYNC_QUEUE, 'readwrite', store => store.delete(job.projectId));
              continue;
          }
          const result = await StorageService.saveProject(userId, project, true, false);
          if (result === 'cloud') {
              await idbOperation(STORE_SYNC_QUEUE, 'readwrite', store => store.delete(job.projectId));
              completed++;
          }
      }
      return completed;
  },

  exportAllUserData: async (userId: string): Promise<{ exportedAt: string; projects: MockupState[] }> => {
      const byId = new Map<string, MockupState>();
      const local = await StorageService.listProjectsLocal();
      for (const meta of local) {
          const project = await StorageService.loadProjectLocal(meta.id);
          if (project) byId.set(project.projectId, project);
      }
      if (!userId.startsWith('guest_')) {
          const cloud = await getDocs(query(collection(db, FIRESTORE_COLLECTION), where('userId', '==', userId)));
          for (const doc of cloud.docs) {
              const projectId = doc.data().projectId as string;
              if (!byId.has(projectId)) {
                  const project = await StorageService.loadProjectCloud(userId, projectId);
                  if (project) byId.set(project.projectId, project);
              }
          }
      }
      return { exportedAt: new Date().toISOString(), projects: [...byId.values()] };
  },

  deleteAllUserData: async (userId: string): Promise<void> => {
      const local = await StorageService.listProjectsLocal();
      await Promise.all(local.map(project => StorageService.deleteProjectLocal(project.id)));
      await idbOperation(STORE_ASSETS, 'readwrite', store => store.clear());
      if (userId.startsWith('guest_')) return;

      const cloud = await getDocs(query(collection(db, FIRESTORE_COLLECTION), where('userId', '==', userId)));
      for (const doc of cloud.docs) await StorageService.deleteProjectCloud(userId, doc.data().projectId);
      const remainingProjects = await getDocs(query(collection(db, FIRESTORE_COLLECTION), where('userId', '==', userId)));
      if (!remainingProjects.empty) throw new Error('Some cloud projects could not be deleted');

      const personal = await getDocs(query(collection(db, 'userLibrary'), where('ownerUid', '==', userId)));
      await Promise.all(personal.docs.map(item => deleteDoc(item.ref)));

      const deleteTree = async (ref: StorageReference): Promise<void> => {
          const listing = await listAll(ref);
          await Promise.all(listing.items.map(deleteObject));
          await Promise.all(listing.prefixes.map(deleteTree));
      };
      await deleteTree(storageRef(storage, `users/${userId}`));

      // Exports are not project references, so deleting the provider's app
      // folder is the only complete way to remove them. Never prompt from this
      // destructive background step; disconnected providers remain untouched.
      for (const connector of connectors) {
          if (await connector.ensureReady(false).catch(() => false)) await connector.deleteAllAppData();
      }
  },

  // --- Cloud Sync (Firestore) ---

  // Without this, a project deleted locally kept living in Firestore forever —
  // and could even reappear, since login loads the most-recently-updated cloud
  // project. Image cleanup is best-effort and never blocks the delete itself.
  deleteProjectCloud: async (userId: string, projectId: string): Promise<void> => {
      if (userId.startsWith('guest_')) return;

      // Collect this project's drive refs BEFORE deleting the doc, so files
      // unique to it can be trashed from the user's drive afterwards.
      let deletedRefs: string[] = [];
      try {
          const snapshot = await getDoc(doc(db, FIRESTORE_COLLECTION, `${userId}_${projectId}`));
          if (snapshot.exists()) deletedRefs = collectDriveRefs(snapshot.data());
      } catch { /* best-effort */ }

      try {
          await deleteDoc(doc(db, FIRESTORE_COLLECTION, `${userId}_${projectId}`));
      } catch (e) {
          console.warn("Could not delete cloud project:", e);
      }
      await pruneOrphanedImages(userId).catch(e => console.warn("Orphaned image prune failed:", e));
      await deleteStorageTree(storageRef(storage, `users/${userId}/captures/${projectId}`)).catch(e => console.warn('Site-capture cleanup failed:', e));

      // Trash drive files no other project still references (best-effort)
      if (deletedRefs.length > 0) {
          try {
              const snapshot = await getDocs(query(collection(db, FIRESTORE_COLLECTION), where('userId', '==', userId)));
              const stillReferenced = new Set<string>(snapshot.docs.flatMap(d => collectDriveRefs(d.data())));
              await Promise.all(deletedRefs.filter(ref => !stillReferenced.has(ref)).map(async ref => {
                  const connector = getConnectorForRef(ref);
                  if (connector && await connector.ensureReady(false).catch(() => false)) await connector.deleteImage(ref);
              }));
          } catch (e) {
              console.warn("Drive image cleanup skipped:", e);
          }
      }
  },

  saveProject: async (userId: string, state: MockupState, fromQueue = false, force = false): Promise<'cloud' | 'local' | 'queued' | 'conflict' | 'error'> => {
      // Always save to local first
      try {
          await StorageService.saveProjectLocal(state);
      } catch (e) {
          reportError('local-sync', e, { userId, projectId: state.projectId });
          return 'error';
      }

      // Skip cloud sync for guest users
      if (userId.startsWith('guest_')) return 'local';
      if (!navigator.onLine) {
          if (!fromQueue) await StorageService.queueProjectSync(userId, state.projectId);
          return 'queued';
      }

      try {
          // Upload base64 images — Firestore only ever gets a URL or drive ref.
          // Destination: the user's connected cloud drive when available, else
          // Firebase Storage. Uploads are deduped per-save (and across saves,
          // via content hash) so an unchanged image is never re-uploaded on
          // every autosave debounce. A drive failure must never fail the save:
          // it silently falls back to Firebase Storage.
          const uploadImage = async (dataUri: string): Promise<string> => {
              dataUri = await optimizeDataUri(dataUri);
              const hash = await hashDataUri(dataUri);

              // Image was loaded from a drive ref this session — reuse it
              const known = getKnownRef(hash);
              if (known) return known;

              const connector = getActiveConnector();
              if (connector && await connector.ensureReady(false)) {
                  try {
                      const ref = await connector.uploadImage(dataUri, hash);
                      recordKnownRef(hash, ref);
                      return ref;
                  } catch (e) {
                      reportWarning('drive-sync', 'Drive upload failed; using Firebase Storage fallback', { provider: connector.id, error: String(e) });
                  }
              }
              return uploadImageIfNeeded(userId, dataUri);
          };

          const uploadCache = new Map<string, Promise<string>>();
          const resolveImage = (dataUri: string): Promise<string> => {
              if (!dataUri || !dataUri.startsWith('data:')) return Promise.resolve(dataUri);
              if (!uploadCache.has(dataUri)) {
                  uploadCache.set(dataUri, uploadImage(dataUri).catch(e => {
                      reportError('image-sync', e, { projectId: state.projectId });
                      // Never turn a temporary compression/provider failure
                      // into a permanently blank cloud image. Abort this cloud
                      // revision and retain the complete IndexedDB copy.
                      throw e;
                  }));
              }
              return uploadCache.get(dataUri)!;
          };

          const canvases = await Promise.all(state.canvases.map(async canvas => ({
              ...canvas,
              backgroundImage: await resolveImage(canvas.backgroundImage),
              signs: await Promise.all(canvas.signs.map(async sign => ({
                  ...sign,
                  image: await resolveImage(sign.image),
              }))),
          })));

          const logoImage = state.titleBlock.logoImage ? await resolveImage(state.titleBlock.logoImage) : null;

          // Reference images were previously synced as raw data URIs — a
          // Firestore 1MB-per-doc time bomb. Route them through the same pipeline.
          const referenceImages = await Promise.all((state.referenceImages ?? []).map(async r => ({
              ...r,
              image: await resolveImage(r.image),
          })));

          const siteCaptures = await Promise.all((state.siteCaptures ?? []).map(async capture => ({
              ...capture,
              originalRef: await uploadSiteCaptureAsset(userId, state.projectId, capture.id, 'original', capture.originalRef),
              workingRef: await uploadSiteCaptureAsset(userId, state.projectId, capture.id, 'working', capture.workingRef),
              thumbnailRef: await uploadSiteCaptureAsset(userId, state.projectId, capture.id, 'thumbnail', capture.thumbnailRef),
              supportingPhotos: await Promise.all((capture.supportingPhotos ?? []).map(async photo => ({
                  ...photo,
                  originalRef: await uploadSiteCaptureAsset(userId, state.projectId, photo.id, 'original', photo.originalRef),
                  workingRef: await uploadSiteCaptureAsset(userId, state.projectId, photo.id, 'working', photo.workingRef),
                  thumbnailRef: await uploadSiteCaptureAsset(userId, state.projectId, photo.id, 'thumbnail', photo.thumbnailRef),
              }))),
          })));

          const cloudState = {
              ...state,
              canvases,
              titleBlock: { ...state.titleBlock, logoImage },
              referenceImages,
              siteCaptures,
          };

          const projectRef = doc(db, FIRESTORE_COLLECTION, `${userId}_${state.projectId}`);
          const key = revisionKey(userId, state.projectId);
          const baseRevision = knownCloudRevisions.get(key) ?? state.cloudRevision ?? 0;
          const nextRevision = await runTransaction(db, async transaction => {
              const remote = await transaction.get(projectRef);
              const remoteRevision = remote.exists() ? (remote.data().cloudRevision ?? 0) : 0;
              if (!force && remote.exists() && remoteRevision > baseRevision) return null;
              const revision = remoteRevision + 1;
              transaction.set(projectRef, { ...cloudState, userId, updatedAt: Date.now(), cloudRevision: revision });
              return revision;
          });
          if (nextRevision === null) return 'conflict';
          knownCloudRevisions.set(key, nextRevision);
          await StorageService.saveProjectLocal({ ...state, cloudRevision: nextRevision });

          return 'cloud';
      } catch (e) {
          reportError('firestore-sync', e, { userId, projectId: state.projectId, permissionDenied: (e as any)?.code === 'permission-denied' });
          return 'local';
      }
  },

  listProjectsCloud: async (userId: string): Promise<ProjectMetadata[]> => {
      if (userId.startsWith('guest_')) return [];
      try {
          // No orderBy — combining `where` with `orderBy` on a different field
          // requires a composite Firestore index to be deployed first, and fails
          // silently (empty list) until that index exists. Sorting client-side
          // needs only the automatic single-field index Firestore always has.
          const snapshot = await getDocs(query(collection(db, FIRESTORE_COLLECTION), where('userId', '==', userId), limit(50)));

          return snapshot.docs.map(doc => {
              const d = doc.data();
              return {
                  id: d.projectId,
                  name: d.projectName ?? 'Untitled Project',
                  lastModified: d.updatedAt ?? d.lastSaved,
                  canvasCount: d.canvases?.length ?? 1,
              };
          }).sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
      } catch (e) {
          reportError('firestore-list', e, { userId, permissionDenied: (e as any)?.code === 'permission-denied' });
          return [];
      }
  },

  loadProjectCloud: async (
      userId: string,
      projectId: string,
      onResolveIssues?: (r: Pick<ResolveResult, 'failedRefs' | 'needsReconnect'>) => void,
  ): Promise<MockupState | null> => {
      if (userId.startsWith('guest_')) return null;
      try {
          const snapshot = await getDoc(doc(db, FIRESTORE_COLLECTION, `${userId}_${projectId}`));

          if (!snapshot.exists()) return null;
          const data = snapshot.data() as MockupState & { userId: string; updatedAt: number };
          // Remove Firestore-only fields before returning
          const { userId: _u, updatedAt: _t, ...projectState } = data;
          knownCloudRevisions.set(revisionKey(userId, projectId), projectState.cloudRevision ?? 0);

          // Materialize any cloud-drive refs into displayable data URIs
          const resolved = await resolveProjectImages(projectState as MockupState);
          if (resolved.failedRefs.length > 0) {
              onResolveIssues?.({ failedRefs: resolved.failedRefs, needsReconnect: resolved.needsReconnect });
          }
          return resolved.state;
      } catch (e) {
          reportError('firestore-load', e, { userId, projectId, permissionDenied: (e as any)?.code === 'permission-denied' });
          return null;
      }
  },
};
