
import { db, storage } from '../firebase';
import { MockupState, ProjectMetadata } from '../types';
import { hashDataUri, dataUriToBlob } from './imageHash';
import { getActiveConnector } from './driveConnectors';
import { getKnownRef, recordKnownRef, resolveProjectImages, ResolveResult, isDriveRef } from './AssetResolver';

const FIRESTORE_COLLECTION = 'projects';
const DB_NAME = 'SignageProDB';
const STORE_PROJECTS = 'projects';
const STORE_METADATA = 'metadata';
const STORE_ASSETS = 'assets'; // cached cloud-drive image blobs, keyed by ref
const DB_VERSION = 3; // v3 adds the assets store

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

export const getCachedAsset = async (ref: string): Promise<CachedAsset | null> =>
    (await idbOperation<CachedAsset>(STORE_ASSETS, 'readonly', (store) => store.get(ref))) ?? null;

export const putCachedAsset = async (ref: string, blob: Blob): Promise<void> => {
    await idbOperation(STORE_ASSETS, 'readwrite', (store) =>
        store.put({ ref, blob, mime: blob.type, cachedAt: Date.now() } as CachedAsset));
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
    const ref = storage.ref(`users/${userId}/images/${hash}`);

    try {
        return await ref.getDownloadURL();
    } catch {
        // Not uploaded yet
        await ref.put(dataUriToBlob(dataUri));
        return await ref.getDownloadURL();
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
    const snapshot = await db.collection(FIRESTORE_COLLECTION).where('userId', '==', userId).get();

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

    const { items } = await storage.ref(`users/${userId}/images`).listAll();
    await Promise.all(items.map(item => {
        if (referenced.has(item.name)) return Promise.resolve();
        return item.delete().catch(e => console.warn(`Failed to prune orphaned image ${item.name}:`, e));
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
          const doc = await db.collection(FIRESTORE_COLLECTION).doc(`${userId}_${projectId}`).get();
          if (doc.exists) deletedRefs = collectDriveRefs(doc.data());
      } catch { /* best-effort */ }

      try {
          await db.collection(FIRESTORE_COLLECTION).doc(`${userId}_${projectId}`).delete();
      } catch (e) {
          console.warn("Could not delete cloud project:", e);
      }
      await pruneOrphanedImages(userId).catch(e => console.warn("Orphaned image prune failed:", e));

      // Trash drive files no other project still references (best-effort)
      const connector = getActiveConnector();
      if (connector && deletedRefs.length > 0 && await connector.ensureReady(false).catch(() => false)) {
          try {
              const snapshot = await db.collection(FIRESTORE_COLLECTION).where('userId', '==', userId).get();
              const stillReferenced = new Set<string>(snapshot.docs.flatMap(d => collectDriveRefs(d.data())));
              await Promise.all(deletedRefs
                  .filter(ref => !stillReferenced.has(ref))
                  .map(ref => connector.deleteImage(ref)));
          } catch (e) {
              console.warn("Drive image cleanup skipped:", e);
          }
      }
  },

  saveProject: async (userId: string, state: MockupState): Promise<'cloud' | 'local' | 'error'> => {
      // Always save to local first
      try {
          await StorageService.saveProjectLocal(state);
      } catch (e) {
          console.error("Local save failed", e);
          return 'error';
      }

      // Skip cloud sync for guest users
      if (userId.startsWith('guest_')) return 'local';

      try {
          // Upload base64 images — Firestore only ever gets a URL or drive ref.
          // Destination: the user's connected cloud drive when available, else
          // Firebase Storage. Uploads are deduped per-save (and across saves,
          // via content hash) so an unchanged image is never re-uploaded on
          // every autosave debounce. A drive failure must never fail the save:
          // it silently falls back to Firebase Storage.
          const uploadImage = async (dataUri: string): Promise<string> => {
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
                      console.warn('Drive upload failed, falling back to Firebase Storage:', e);
                  }
              }
              return uploadImageIfNeeded(userId, dataUri);
          };

          const uploadCache = new Map<string, Promise<string>>();
          const resolveImage = (dataUri: string): Promise<string> => {
              if (!dataUri || !dataUri.startsWith('data:')) return Promise.resolve(dataUri);
              if (!uploadCache.has(dataUri)) {
                  uploadCache.set(dataUri, uploadImage(dataUri).catch(e => {
                      console.warn("Image upload failed, image will be blank in cloud copy:", e);
                      return '';
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

          const cloudState = {
              ...state,
              canvases,
              titleBlock: { ...state.titleBlock, logoImage },
              referenceImages,
          };

          await db
              .collection(FIRESTORE_COLLECTION)
              .doc(`${userId}_${state.projectId}`)
              .set({
                  ...cloudState,
                  userId,
                  updatedAt: Date.now(),
              });

          return 'cloud';
      } catch (e) {
          console.warn("Cloud save failed, project is local only:", e);
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
          const snapshot = await db
              .collection(FIRESTORE_COLLECTION)
              .where('userId', '==', userId)
              .limit(50)
              .get();

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
          console.warn("Could not list cloud projects:", e);
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
          const doc = await db
              .collection(FIRESTORE_COLLECTION)
              .doc(`${userId}_${projectId}`)
              .get();

          if (!doc.exists) return null;
          const data = doc.data() as MockupState & { userId: string; updatedAt: number };
          // Remove Firestore-only fields before returning
          const { userId: _u, updatedAt: _t, ...projectState } = data;

          // Materialize any cloud-drive refs into displayable data URIs
          const resolved = await resolveProjectImages(projectState as MockupState);
          if (resolved.failedRefs.length > 0) {
              onResolveIssues?.({ failedRefs: resolved.failedRefs, needsReconnect: resolved.needsReconnect });
          }
          return resolved.state;
      } catch (e) {
          console.warn("Could not load cloud project:", e);
          return null;
      }
  },
};
