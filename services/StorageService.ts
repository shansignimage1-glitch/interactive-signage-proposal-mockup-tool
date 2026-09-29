
import { db, storage } from '../firebase';
import { collection, deleteDoc, doc, getDoc, getDocFromServer, getDocs, getDocsFromServer, query, runTransaction, setDoc, where } from 'firebase/firestore';
import { deleteObject, getBytes, getDownloadURL, listAll, ref as storageRef, uploadBytes, type StorageReference } from 'firebase/storage';
import { MockupState, ProjectMetadata } from '../types';
import { hashDataUri, dataUriToBlob } from './imageHash';
import { connectors, getActiveConnector, getConnectorForRef } from './driveConnectors';
import { forgetKnownRef, getKnownRef, recordKnownRef, resolveProjectImages, ResolveResult, isDriveRef } from './AssetResolver';
import { reportError, reportWarning } from './monitoring';
import { assertStorageCapacity, optimizeDataUri } from './imageProcessing';
import { decodeProjectFromFirestore, withoutUndefined } from '../utils/firestorePayload';
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';

export type ProjectSaveResult = 'cloud' | 'local' | 'queued' | 'conflict' | 'error';

const FIRESTORE_COLLECTION = 'projects';
const DB_NAME = 'SignageProDB';
const STORE_PROJECTS = 'projects';
const STORE_METADATA = 'metadata';
const STORE_ASSETS = 'assets'; // cached cloud-drive image blobs, keyed by ref
const STORE_SYNC_QUEUE = 'syncQueue';
const STORE_CAPTURE_CLOUD_REFS = 'captureCloudRefs';
const DB_VERSION = 5; // v5 persists local/hosted capture-ref to committed cloud-object mappings.
const PROJECT_STATE_SCHEMA_VERSION = 2;
const knownCloudRevisions = new Map<string, number>();
const knownCloudProjectIndexes = new Map<string, CloudProjectIndex>();
const knownCloudProjectIndexFetchedAt = new Map<string, number>();
const projectSaveTails = new Map<string, Promise<void>>();
const projectLocalSaveTails = new Map<string, Promise<void>>();
const latestProjectSaveSequences = new Map<string, number>();
const latestPersistedProjectSaveSequences = new Map<string, number>();
const latestProjectSaveTimestamps = new Map<string, number>();
const cloudProjectListRefreshedAt = new Map<string, number>();
const projectDeletionEpochs = new Map<string, number>();
const deletedProjectKeys = new Set<string>();
const projectSyncConflicts = new Set<string>();
const revisionKey = (userId: string, projectId: string) => `${userId}_${projectId}`;
const projectDocumentId = (userId: string, projectId: string) => `${userId}_${encodeURIComponent(projectId)}`;
const projectStorageId = (projectId: string) => encodeURIComponent(projectId);
const projectStateRoot = (userId: string, projectId: string) => `users/${userId}/projects/${projectStorageId(projectId)}`;
const canUseLocalProject = (state: MockupState | null, userId: string): state is MockupState => {
    if (!state) return false;
    const ownerUid = state.user?.uid;
    return !ownerUid || ownerUid.startsWith('guest_') || ownerUid === userId;
};

// Stricter than canUseLocalProject (which lets a signed-in account adopt legacy
// guest work): a device can be shared, so guests must never see a signed-in
// account's cached projects, and one account's export/delete-all must never
// include or destroy another account's local (possibly unsynced) work.
const isOwnedLocalProject = (state: MockupState | null, userId: string): state is MockupState => {
    if (!state) return false;
    const ownerUid = state.user?.uid;
    if (userId.startsWith('guest_')) return !ownerUid || ownerUid.startsWith('guest_');
    return !ownerUid || ownerUid === userId;
};

type CloudProjectIndex = {
    schemaVersion?: number;
    statePath?: string;
    stateUrl?: string;
    stateEncoding?: 'json' | 'gzip';
    previousStatePath?: string;
    previousStateUrl?: string;
    previousStateEncoding?: 'json' | 'gzip';
    previousStateRevision?: number;
    captureObjectPaths?: string[];
    previousCaptureObjectPaths?: string[];
    userId: string;
    projectId: string;
    projectName?: string;
    updatedAt: number;
    lastSaved?: number;
    cloudRevision?: number;
    canvasCount?: number;
    hasImage?: boolean;
    [key: string]: unknown;
};

const cachedCloudProjectMetadata = (userId: string): ProjectMetadata[] =>
    [...knownCloudProjectIndexes.values()]
        .filter(index => index.userId === userId)
        .map(index => ({
            id: index.projectId,
            name: index.projectName ?? 'Untitled Project',
            lastModified: index.updatedAt ?? index.lastSaved ?? 0,
            canvasCount: index.canvasCount ?? 1,
        }));

type ProjectLockReservation = { waitForTurn: Promise<void>; release: () => void };

const reserveProjectLock = (tails: Map<string, Promise<void>>, key: string): ProjectLockReservation => {
    const previous = tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>(resolve => { releaseCurrent = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    tails.set(key, tail);

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        releaseCurrent();
        if (tails.get(key) === tail) tails.delete(key);
    };
    return { waitForTurn: previous.catch(() => undefined), release };
};

const serializeCloudProjectState = async (state: MockupState): Promise<{ blob: Blob; encoding: 'json' | 'gzip' }> => {
    const json = JSON.stringify(withoutUndefined(state));
    return { blob: new Blob([gzipSync(strToU8(json))], { type: 'application/gzip' }), encoding: 'gzip' };
};

const decodeCloudProjectState = async (bytes: ArrayBuffer, encoding: 'json' | 'gzip' = 'json'): Promise<MockupState> => {
    if (encoding === 'gzip') {
        return JSON.parse(strFromU8(gunzipSync(new Uint8Array(bytes)))) as MockupState;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as MockupState;
};

const downloadCloudProjectState = async (path: string, url?: string): Promise<ArrayBuffer> => {
    if (url) {
        try {
            const response = await fetch(url);
            if (response.ok) return response.arrayBuffer();
            reportWarning('project-state-download', 'Cloud state URL failed; retrying through authenticated Storage', {
                status: response.status,
            });
        } catch (error) {
            reportWarning('project-state-download', 'Cloud state URL failed; retrying through authenticated Storage', {
                error: String(error),
            });
        }
    }
    return getBytes(storageRef(storage, path), 50 * 1024 * 1024);
};

const readCloudProjectState = async (data: CloudProjectIndex): Promise<MockupState> => {
    if (data.schemaVersion === PROJECT_STATE_SCHEMA_VERSION && data.statePath) {
        const bytes = await downloadCloudProjectState(data.statePath, data.stateUrl);
        const state = await decodeCloudProjectState(bytes, data.stateEncoding);
        state.projectId = data.projectId;
        state.projectName = data.projectName ?? state.projectName ?? 'Untitled Project';
        state.cloudRevision = data.cloudRevision ?? state.cloudRevision ?? 0;
        state.lastSaved = Math.max(state.lastSaved ?? 0, data.updatedAt ?? data.lastSaved ?? 0);
        return state;
    }

    // Backward compatibility for projects written before Storage-backed state.
    const { userId: _u, updatedAt: _t, ...legacyState } = data;
    const state = decodeProjectFromFirestore(legacyState);
    state.lastSaved = Math.max(state.lastSaved ?? 0, _t ?? 0);
    return state;
};

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
      if (!db.objectStoreNames.contains(STORE_CAPTURE_CLOUD_REFS)) {
        db.createObjectStore(STORE_CAPTURE_CLOUD_REFS, { keyPath: 'key' });
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

interface CaptureCloudRefMapping {
    key: string;
    userId: string;
    projectId: string;
    sourceRef: string;
    cloudUrl: string;
    objectPath: string;
    updatedAt: number;
}

const captureCloudRefMappingKey = (
    userId: string,
    projectId: string,
    captureId: string,
    kind: SiteCaptureAssetKind,
    sourceRef: string,
) => `${userId}|${projectId}|${captureId}|${kind}|${sourceRef}`;

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

export type SiteCaptureAssetKind = 'original' | 'working' | 'thumbnail' | 'dictation' | 'annotation-base';
const SITE_CAPTURE_SCHEME = 'site-capture://';

export const makeSiteCaptureAssetRef = (projectId: string, captureId: string, kind: SiteCaptureAssetKind, version?: string): string => {
    const safeVersion = version?.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${SITE_CAPTURE_SCHEME}${projectId}/${captureId}/${kind}${safeVersion ? `/${safeVersion}` : ''}`;
};

const getCaptureCloudRefMapping = async (key: string): Promise<CaptureCloudRefMapping | null> =>
    (await idbOperation<CaptureCloudRefMapping>(STORE_CAPTURE_CLOUD_REFS, 'readonly', store => store.get(key))) ?? null;

const putCaptureCloudRefMappings = async (mappings: Iterable<CaptureCloudRefMapping>): Promise<void> => {
    const entries = [...mappings];
    if (!entries.length) return;
    const db = await initDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_CAPTURE_CLOUD_REFS, 'readwrite');
        const store = tx.objectStore(STORE_CAPTURE_CLOUD_REFS);
        entries.forEach(mapping => store.put(mapping));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Capture cloud-reference mapping save was aborted.'));
    });
};

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

export const deleteSiteCaptureAssetRefs = async (refs: readonly string[]): Promise<void> => {
    const uniqueRefs = [...new Set(refs.filter(ref => ref.startsWith(SITE_CAPTURE_SCHEME)))];
    if (!uniqueRefs.length) return;
    const db = await initDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ASSETS, 'readwrite');
        uniqueRefs.forEach(ref => tx.objectStore(STORE_ASSETS).delete(ref));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
};

const uploadSiteCaptureAsset = async (
    userId: string,
    projectId: string,
    captureId: string,
    kind: SiteCaptureAssetKind,
    ref: string,
    createdObjectPaths?: Set<string>,
    uploadAttemptId?: string,
    retainedObjectPaths?: Set<string>,
    pendingMappings?: Map<string, CaptureCloudRefMapping>,
): Promise<string> => {
    const attemptId = uploadAttemptId?.replace(/[^a-zA-Z0-9_-]/g, '_') ?? Math.random().toString(36).slice(2);
    const mappingKey = captureCloudRefMappingKey(userId, projectId, captureId, kind, ref);
    const mapped = await getCaptureCloudRefMapping(mappingKey);
    if (mapped && retainedObjectPaths?.has(mapped.objectPath)) return mapped.cloudUrl;
    const rememberMapping = (cloudUrl: string, objectPath: string) => {
        pendingMappings?.set(mappingKey, {
            key: mappingKey,
            userId,
            projectId,
            sourceRef: ref,
            cloudUrl,
            objectPath,
            updatedAt: Date.now(),
        });
        return cloudUrl;
    };
    if (!ref.startsWith(SITE_CAPTURE_SCHEME)) {
        const hostedPath = extractStorageObjectPath(ref);
        if (hostedPath && retainedObjectPaths?.has(hostedPath)) return ref;

        // A forced restore can carry a URL older than both retained revisions.
        // Copy it to this save's unique path before committing so concurrent GC
        // can remove the obsolete source without breaking the new revision.
        let asset = (await getCachedAsset(ref))?.blob;
        if (!asset) {
            try {
                const response = await fetch(ref);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                asset = await response.blob();
            } catch (downloadError) {
                if (!hostedPath) throw downloadError;
                const bytes = await getBytes(storageRef(storage, hostedPath), 50 * 1024 * 1024);
                asset = new Blob([bytes]);
            }
        }
        const restoredPath = `users/${userId}/captures/${projectId}/${captureId}/${kind}-restore-${attemptId}`;
        const restoredRef = storageRef(storage, restoredPath);
        await uploadBytes(restoredRef, asset, { contentType: asset.type || undefined });
        createdObjectPaths?.add(restoredPath);
        return rememberMapping(await getDownloadURL(restoredRef), restoredPath);
    }
    const asset = await getSiteCaptureAsset(ref);
    if (!asset) throw new Error(`Site-capture ${kind} is missing from this device.`);
    const localParts = ref.slice(SITE_CAPTURE_SCHEME.length).split('/');
    const version = localParts.length > 3
        ? localParts.slice(3).join('-').replace(/[^a-zA-Z0-9_-]/g, '_')
        : '';
    // Marked-up working images use a new immutable object name per save. This
    // prevents Firebase's existing-object shortcut from returning an older,
    // unannotated photo while another device is syncing the new revision.
    const objectName = version ? `${kind}-${version}-${attemptId}` : kind;
    const destinationPath = `users/${userId}/captures/${projectId}/${captureId}/${objectName}`;
    const destination = storageRef(storage, destinationPath);
    try { return rememberMapping(await getDownloadURL(destination), destinationPath); }
    catch (error) {
        await uploadBytes(destination, asset, { contentType: asset.type || undefined });
        // Only attempt-unique paths are rolled back. Stable original/base
        // objects can be shared by concurrent tabs and are pruned with their
        // project, never by a losing save.
        if (version) createdObjectPaths?.add(destinationPath);
        return rememberMapping(await getDownloadURL(destination), destinationPath);
    }
};

const deleteStorageTree = async (root: StorageReference): Promise<void> => {
    const listing = await listAll(root);
    await Promise.all(listing.items.map(deleteObject));
    await Promise.all(listing.prefixes.map(deleteStorageTree));
};

const collectSiteCaptureAssetRefs = (project: any): string[] => {
    const refs = new Set<string>();
    const track = (value?: string | null) => {
        if (typeof value === 'string' && value.startsWith(SITE_CAPTURE_SCHEME)) refs.add(value);
    };
    if (!Array.isArray(project?.siteCaptures)) return [];
    project.siteCaptures.forEach((capture: any) => {
        track(capture?.originalRef);
        track(capture?.annotationBaseRef);
        track(capture?.workingRef);
        track(capture?.thumbnailRef);
        if (!Array.isArray(capture?.supportingPhotos)) return;
        capture.supportingPhotos.forEach((photo: any) => {
            track(photo?.originalRef);
            track(photo?.workingRef);
            track(photo?.thumbnailRef);
        });
    });
    return [...refs];
};

type CloudStatePointer = {
    path: string;
    url?: string;
    encoding?: 'json' | 'gzip';
};

const cloudStatePointer = (index: CloudProjectIndex, previous = false): CloudStatePointer | null => {
    const path = previous ? index.previousStatePath : index.statePath;
    if (!path) return null;
    return {
        path,
        url: previous ? index.previousStateUrl : index.stateUrl,
        encoding: previous ? index.previousStateEncoding : index.stateEncoding,
    };
};

const readCloudStatePointer = async (pointer: CloudStatePointer): Promise<MockupState> => {
    const bytes = await downloadCloudProjectState(pointer.path, pointer.url);
    return decodeCloudProjectState(bytes, pointer.encoding);
};

const readRetainedCloudStates = async (index: CloudProjectIndex): Promise<MockupState[]> => {
    const pointers = [cloudStatePointer(index), cloudStatePointer(index, true)]
        .filter((pointer): pointer is CloudStatePointer => Boolean(pointer));
    return Promise.all(pointers.map(readCloudStatePointer));
};

const extractStorageObjectPath = (url: string): string | null => {
    if (!url) return null;
    const encodedPath = /\/o\/([^?]+)/.exec(url)?.[1];
    if (encodedPath) {
        try { return decodeURIComponent(encodedPath); }
        catch { return null; }
    }
    try {
        const path = decodeURIComponent(new URL(url).pathname);
        const usersIndex = path.indexOf('/users/');
        return usersIndex >= 0 ? path.slice(usersIndex + 1) : null;
    } catch {
        return null;
    }
};

const captureProjectObjectPrefix = (userId: string, projectId: string) =>
    `users/${userId}/captures/${projectId}/`;

const collectCloudSiteCaptureObjectPaths = (project: any, expectedPrefix?: string): Set<string> => {
    const paths = new Set<string>();
    const track = (value?: string | null) => {
        if (typeof value !== 'string') return;
        const path = extractStorageObjectPath(value);
        if (path?.includes('/captures/') && (!expectedPrefix || path.startsWith(expectedPrefix))) paths.add(path);
    };
    (project?.siteCaptures ?? []).forEach((capture: any) => {
        track(capture?.originalRef);
        track(capture?.annotationBaseRef);
        track(capture?.workingRef);
        track(capture?.thumbnailRef);
        (capture?.supportingPhotos ?? []).forEach((photo: any) => {
            track(photo?.originalRef);
            track(photo?.workingRef);
            track(photo?.thumbnailRef);
        });
    });
    // Legacy promoted canvases do not have siteCaptureLink metadata. Their
    // background can still point at an older immutable capture object after a
    // newer phone annotation replaces workingRef, so it must remain in the
    // retained manifest until that canvas is changed or removed.
    (project?.canvases ?? []).forEach((canvas: any) => track(canvas?.backgroundImage));
    return paths;
};

const collectHostedSiteCaptureRefs = (project: any): string[] => {
    const refs = new Set<string>();
    const track = (value?: string | null) => {
        if (typeof value === 'string' && /^https?:/i.test(value)) refs.add(value);
    };
    (project?.siteCaptures ?? []).forEach((capture: any) => {
        track(capture?.originalRef);
        track(capture?.annotationBaseRef);
        track(capture?.workingRef);
        track(capture?.thumbnailRef);
        (capture?.supportingPhotos ?? []).forEach((photo: any) => {
            track(photo?.originalRef);
            track(photo?.workingRef);
            track(photo?.thumbnailRef);
        });
    });
    // Keep the durable cached copy for a capture-backed editor background too.
    // This covers legacy promoted canvases and prevents local pruning from
    // removing the only offline copy while the canvas still references it.
    (project?.canvases ?? []).forEach((canvas: any) => {
        const value = canvas?.backgroundImage;
        if (typeof value !== 'string' || !/^https?:/i.test(value)) return;
        const path = extractStorageObjectPath(value);
        if (path?.startsWith('users/') && path.includes(`/captures/${project.projectId}/`)) refs.add(value);
    });
    return [...refs];
};

const downloadHostedSiteCapture = async (url: string): Promise<Blob> => {
    const path = extractStorageObjectPath(url);
    if (path) {
        try {
            // Prefer the authenticated SDK path. Direct download URLs can
            // remain pending in iPhone WebKit against the Storage emulator and
            // stale tokens fail even when the signed-in user still has access.
            // getBytes is deterministic in both cases and enforces Storage
            // rules for the current account.
            const bytes = await getBytes(storageRef(storage, path), 50 * 1024 * 1024);
            return new Blob([bytes]);
        } catch (storageError) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.blob();
            } catch {
                throw storageError;
            }
        }
    }
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
    } catch (downloadError) {
        if (!path) throw downloadError;
        const bytes = await getBytes(storageRef(storage, path), 50 * 1024 * 1024);
        return new Blob([bytes]);
    }
};

const cacheHostedSiteCaptureAssets = async (project: MockupState): Promise<void> => {
    const refs = collectHostedSiteCaptureRefs(project);
    if (!refs.length) return;
    let cursor = 0;
    const failures: unknown[] = [];
    const worker = async () => {
        while (cursor < refs.length) {
            const ref = refs[cursor++];
            try {
                if (await getCachedAsset(ref)) continue;
                await putCachedAsset(ref, await downloadHostedSiteCapture(ref));
            } catch (error) {
                failures.push(error);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, refs.length) }, worker));
    if (failures.length) {
        throw new Error('One or more site photographs could not be cached safely for offline recovery.', { cause: failures[0] });
    }
};

type CloudCaptureRetentionState = {
    revision: number;
    currentObjectPaths: Set<string>;
    retainedObjectPaths: Set<string>;
    expectedExists: boolean;
    expectedStatePath?: string;
};

const captureRetentionStateFromIndex = async (
    userId: string,
    projectId: string,
    index: CloudProjectIndex,
): Promise<CloudCaptureRetentionState> => {
    const hasCurrentManifest = Array.isArray(index.captureObjectPaths);
    const hasPreviousManifest = Array.isArray(index.previousCaptureObjectPaths) || !index.previousStatePath;
    if (hasCurrentManifest && hasPreviousManifest) {
        const currentObjectPaths = new Set(index.captureObjectPaths ?? []);
        return {
            revision: index.cloudRevision ?? 0,
            currentObjectPaths,
            retainedObjectPaths: new Set([...currentObjectPaths, ...(index.previousCaptureObjectPaths ?? [])]),
            expectedExists: true,
            expectedStatePath: index.statePath,
        };
    }

    const currentState = cloudStatePointer(index) ? await readCloudStatePointer(cloudStatePointer(index)!) : null;
    const previousState = cloudStatePointer(index, true) ? await readCloudStatePointer(cloudStatePointer(index, true)!) : null;
    const expectedPrefix = captureProjectObjectPrefix(userId, projectId);
    const currentObjectPaths = currentState ? collectCloudSiteCaptureObjectPaths(currentState, expectedPrefix) : new Set<string>();
    const previousObjectPaths = previousState ? collectCloudSiteCaptureObjectPaths(previousState, expectedPrefix) : new Set<string>();
    return {
        revision: index.cloudRevision ?? 0,
        currentObjectPaths,
        retainedObjectPaths: new Set([...currentObjectPaths, ...previousObjectPaths]),
        expectedExists: true,
        expectedStatePath: index.statePath,
    };
};

const readAuthoritativeCloudCaptureState = async (
    userId: string,
    projectId: string,
): Promise<CloudCaptureRetentionState> => {
    const snapshot = await getDocFromServer(doc(db, FIRESTORE_COLLECTION, projectDocumentId(userId, projectId)));
    if (!snapshot.exists()) {
        return {
            revision: 0,
            currentObjectPaths: new Set(),
            retainedObjectPaths: new Set(),
            expectedExists: false,
        };
    }
    return captureRetentionStateFromIndex(userId, projectId, snapshot.data() as CloudProjectIndex);
};

const deleteCloudCaptureObjectPaths = async (paths: Iterable<string>): Promise<void> => {
    await Promise.all([...new Set(paths)].map(path => deleteObject(storageRef(storage, path))));
};

const pruneSupersededCloudCaptureAssets = async (
    userId: string,
    projectId: string,
    obsoleteState: CloudStatePointer | null,
    obsoleteObjectPaths?: string[],
): Promise<void> => {
    if (!obsoleteState && !obsoleteObjectPaths?.length) return;
    const candidates = obsoleteObjectPaths?.length
        ? new Set(obsoleteObjectPaths)
        : collectCloudSiteCaptureObjectPaths(
            await readCloudStatePointer(obsoleteState!),
            captureProjectObjectPrefix(userId, projectId),
        );
    if (!candidates.size) return;

    // Refresh the authoritative pointer immediately before deleting anything.
    // Only objects absent from both retained project revisions are eligible.
    const latestSnapshot = await getDocFromServer(doc(db, FIRESTORE_COLLECTION, projectDocumentId(userId, projectId)));
    if (!latestSnapshot.exists()) return;
    const latestIndex = latestSnapshot.data() as CloudProjectIndex;
    const hasManifest = Array.isArray(latestIndex.captureObjectPaths)
        && (Array.isArray(latestIndex.previousCaptureObjectPaths) || !latestIndex.previousStatePath);
    const retained = hasManifest
        ? new Set([...(latestIndex.captureObjectPaths ?? []), ...(latestIndex.previousCaptureObjectPaths ?? [])])
        : new Set((await readRetainedCloudStates(latestIndex)).flatMap(state => [
            ...collectCloudSiteCaptureObjectPaths(state, captureProjectObjectPrefix(userId, projectId)),
        ]));
    if (!hasManifest && !retained.size) return;
    const projectPrefix = `users/${userId}/captures/${projectId}/`;
    await deleteCloudCaptureObjectPaths([...candidates].filter(path => path.startsWith(projectPrefix) && !retained.has(path)));
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

    for (const projectDoc of snapshot.docs) {
        const d = await readCloudProjectState(projectDoc.data() as CloudProjectIndex);
        track(d.titleBlock?.logoImage);
        (d.referenceImages ?? []).forEach((r: any) => track(r?.image));
        (d.canvases ?? []).forEach((canvas: any) => {
            track(canvas.backgroundImage);
            (canvas.signs ?? []).forEach((sign: any) => track(sign.image));
        });
    }

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
      const db = await initDB();
      await new Promise<void>((resolve, reject) => {
          // One transaction makes the project pointer and asset cleanup atomic,
          // and IndexedDB serializes overlapping writers across browser tabs.
          const tx = db.transaction([STORE_PROJECTS, STORE_METADATA, STORE_ASSETS, STORE_CAPTURE_CLOUD_REFS], 'readwrite');
          const projects = tx.objectStore(STORE_PROJECTS);
          const assets = tx.objectStore(STORE_ASSETS);
          const mappings = tx.objectStore(STORE_CAPTURE_CLOUD_REFS);
          const previousRequest = projects.get(projectId);
          const mappingRequest = mappings.getAll();
          let removedCaptureRefs: Set<string> | null = null;
          let mappingRecords: CaptureCloudRefMapping[] | null = null;
          const pruneMappings = () => {
              if (!removedCaptureRefs || !mappingRecords) return;
              mappingRecords
                  .filter(mapping => mapping.projectId === projectId && removedCaptureRefs!.has(mapping.sourceRef))
                  .forEach(mapping => mappings.delete(mapping.key));
          };
          previousRequest.onsuccess = () => {
              const retainedCaptureRefs = new Set([
                  ...collectSiteCaptureAssetRefs(state),
                  ...collectHostedSiteCaptureRefs(state),
              ]);
              removedCaptureRefs = new Set([
                  ...collectSiteCaptureAssetRefs(previousRequest.result),
                  ...collectHostedSiteCaptureRefs(previousRequest.result),
              ].filter(ref => !retainedCaptureRefs.has(ref)));
              removedCaptureRefs.forEach(ref => {
                  if (!retainedCaptureRefs.has(ref)) assets.delete(ref);
              });
              pruneMappings();
              projects.put(state);
              tx.objectStore(STORE_METADATA).put(metadata);
          };
          mappingRequest.onsuccess = () => {
              mappingRecords = mappingRequest.result as CaptureCloudRefMapping[];
              pruneMappings();
          };
          previousRequest.onerror = () => tx.abort();
          mappingRequest.onerror = () => tx.abort();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? previousRequest.error ?? mappingRequest.error);
          tx.onabort = () => reject(tx.error ?? previousRequest.error ?? mappingRequest.error ?? new Error('Local project save was aborted.'));
      });
  },

  loadProjectLocal: async (projectId: string): Promise<MockupState | null> => {
      return await idbOperation<MockupState>(STORE_PROJECTS, 'readonly', (store) => store.get(projectId));
  },

  listProjectsLocal: async (): Promise<ProjectMetadata[]> => {
      return await idbOperation<ProjectMetadata[]>(STORE_METADATA, 'readonly', (store) => store.getAll());
  },

  /** Returns one cross-device project list, keeping the newest metadata per id.
   *  `onLocal` receives this device's projects before the (possibly slow)
   *  cloud read, so callers can render them immediately. */
  listProjects: async (userId: string, onLocal?: (local: ProjectMetadata[]) => void): Promise<ProjectMetadata[]> => {
      const localCandidates = await StorageService.listProjectsLocal();
      if (userId.startsWith('guest_')) {
          const guestOwned = await Promise.all(localCandidates.map(async project =>
              isOwnedLocalProject(await StorageService.loadProjectLocal(project.id), userId)));
          return localCandidates
              .filter((_, index) => guestOwned[index])
              .sort((a, b) => b.lastModified - a.lastModified);
      }
      const localOwnership = await Promise.all(localCandidates.map(async project =>
          canUseLocalProject(await StorageService.loadProjectLocal(project.id), userId)));
      const local = localCandidates.filter((_, index) => localOwnership[index]);
      onLocal?.([...local].sort((a, b) => b.lastModified - a.lastModified));
      // Auth bootstrap just fetched and cached this user's complete list. Reuse
      // that fresh result when Project Manager opens instead of starting a
      // second WebKit Firestore channel that can stall for tens of seconds.
      const listAge = Date.now() - (cloudProjectListRefreshedAt.get(userId) ?? 0);
      const cloud = listAge < 15_000
          ? cachedCloudProjectMetadata(userId)
          : await StorageService.listProjectsCloud(userId);
      const byId = new Map<string, ProjectMetadata>();
      for (const project of [...local, ...cloud]) {
          const existing = byId.get(project.id);
          if (!existing || project.lastModified > existing.lastModified) byId.set(project.id, project);
      }
      return [...byId.values()].sort((a, b) => b.lastModified - a.lastModified);
  },

  /** Loads the newest available copy and caches cloud-only projects on this device. */
  loadProject: async (
      userId: string,
      projectId: string,
      onResolveIssues?: (r: Pick<ResolveResult, 'failedRefs' | 'needsReconnect'>) => void,
      throwOnCloudError = false,
  ): Promise<MockupState | null> => {
      const localCandidate = await StorageService.loadProjectLocal(projectId);
      if (userId.startsWith('guest_')) return isOwnedLocalProject(localCandidate, userId) ? localCandidate : null;
      const local = canUseLocalProject(localCandidate, userId) ? localCandidate : null;
      // A zero revision is an explicitly local-only project. Open it
      // immediately instead of blocking iPhone Safari on a cloud get for a
      // document that cannot exist yet, and queue its first cloud revision.
      if (local && (local.cloudRevision ?? 0) === 0) {
          await StorageService.queueProjectSync(userId, projectId);
          return local;
      }
      // Opening a previously cloud-saved project while offline is a read, not
      // an edit. Queueing it here can later replay stale contents over a newer
      // revision from another device.
      if (!navigator.onLine && local) return local;

      const hasPendingLocalChanges = local
          ? await StorageService.hasQueuedProjectSync(userId, projectId)
          : false;
      const cloud = await StorageService.loadProjectCloud(userId, projectId, onResolveIssues, false, throwOnCloudError);
      // A failed/empty cloud read must not manufacture a dirty write. Existing
      // queued edits remain queued; a clean cached revision stays read-only.
      if (!cloud) return local;
      if (local && hasPendingLocalChanges) return local;
      if (local
          && local.lastSaved > cloud.lastSaved
          && (local.cloudRevision ?? 0) >= (cloud.cloudRevision ?? 0)) {
          await StorageService.queueProjectSync(userId, projectId);
          return local;
      }
      await StorageService.saveProjectLocal(cloud);
      StorageService.adoptCloudRevision(userId, projectId, cloud.cloudRevision ?? 0);
      return cloud;
  },

  /** Record that the editor now holds this cloud revision, so the next save
   *  uses it as its base. Only call when the cloud copy actually replaces the
   *  local one — see loadProjectCloud. */
  adoptCloudRevision: (userId: string, projectId: string, revision: number): void => {
      const key = revisionKey(userId, projectId);
      knownCloudRevisions.set(key, revision);
      projectSyncConflicts.delete(key);
  },

  deleteProjectLocal: async (projectId: string): Promise<void> => {
      const db = await initDB();
      await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
              [STORE_PROJECTS, STORE_METADATA, STORE_SYNC_QUEUE, STORE_ASSETS, STORE_CAPTURE_CLOUD_REFS],
              'readwrite',
          );
          const projects = tx.objectStore(STORE_PROJECTS);
          const assets = tx.objectStore(STORE_ASSETS);
          const mappings = tx.objectStore(STORE_CAPTURE_CLOUD_REFS);
          const projectRequest = projects.get(projectId);
          const mappingRequest = mappings.getAll();
          projectRequest.onsuccess = () => {
              const project = projectRequest.result;
              [...collectSiteCaptureAssetRefs(project), ...collectHostedSiteCaptureRefs(project)]
                  .forEach(ref => assets.delete(ref));
          };
          mappingRequest.onsuccess = () => {
              (mappingRequest.result as CaptureCloudRefMapping[])
                  .filter(mapping => mapping.projectId === projectId)
                  .forEach(mapping => mappings.delete(mapping.key));
          };
          projects.delete(projectId);
          tx.objectStore(STORE_METADATA).delete(projectId);
          tx.objectStore(STORE_SYNC_QUEUE).delete(projectId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? projectRequest.error ?? mappingRequest.error);
          tx.onabort = () => reject(tx.error ?? projectRequest.error ?? mappingRequest.error ?? new Error('Local project deletion was aborted.'));
      });
  },

  queueProjectSync: async (userId: string, projectId: string): Promise<void> => {
      await idbOperation(STORE_SYNC_QUEUE, 'readwrite', store => store.put({ projectId, userId, queuedAt: Date.now() }));
  },

  hasQueuedProjectSync: async (userId: string, projectId?: string): Promise<boolean> => {
      const jobs = await idbOperation<Array<{ projectId: string; userId: string }>>(STORE_SYNC_QUEUE, 'readonly', store => store.getAll());
      return jobs.some(job => job.userId === userId && (!projectId || job.projectId === projectId));
  },

  hasProjectSyncConflict: (userId: string, projectId: string): boolean =>
      projectSyncConflicts.has(revisionKey(userId, projectId)),

  discardQueuedProjectSync: async (userId: string, projectId: string): Promise<void> => {
      const queued = await idbOperation<{ projectId: string; userId: string } | undefined>(
          STORE_SYNC_QUEUE,
          'readonly',
          store => store.get(projectId),
      );
      if (queued?.userId === userId) {
          await idbOperation(STORE_SYNC_QUEUE, 'readwrite', store => store.delete(projectId));
      }
      projectSyncConflicts.delete(revisionKey(userId, projectId));
  },

  flushSyncQueue: async (userId: string): Promise<number> => {
      if (!navigator.onLine || userId.startsWith('guest_')) return 0;
      const jobs = await idbOperation<Array<{ projectId: string; userId: string }>>(STORE_SYNC_QUEUE, 'readonly', store => store.getAll());
      let completed = 0;
      for (const job of jobs.filter(item => item.userId === userId)) {
          const project = await StorageService.loadProjectLocal(job.projectId);
          if (!project) {
              await idbOperation(STORE_SYNC_QUEUE, 'readwrite', store => store.delete(job.projectId));
              projectSyncConflicts.delete(revisionKey(userId, job.projectId));
              continue;
          }
          if (project.user?.uid !== job.userId) {
              // Queue records are account-scoped. Never replay a guest or
              // another account's local snapshot into this user's cloud path.
              await idbOperation(STORE_SYNC_QUEUE, 'readwrite', store => store.delete(job.projectId));
              projectSyncConflicts.delete(revisionKey(userId, job.projectId));
              reportWarning('sync-queue', 'Discarded a queued project whose local owner no longer matches', {
                  projectId: job.projectId,
                  queuedUserId: job.userId,
                  localOwnerUid: project.user?.uid ?? null,
              });
              continue;
          }
          let projectToSync = project;
          try {
              // A previous app version could save the first cloud revision but
              // leave the live editor at revision zero. Before replaying a
              // durable queued edit after reload, recover the authoritative
              // base revision without replacing the newer local contents.
              const key = revisionKey(userId, job.projectId);
              const snapshot = await getDoc(doc(db, FIRESTORE_COLLECTION, projectDocumentId(userId, job.projectId)));
              if (snapshot.exists()) {
                  const index = snapshot.data() as CloudProjectIndex;
                  const remoteRevision = index.cloudRevision ?? 0;
                  const localRevision = project.cloudRevision ?? 0;
                  const remoteSavedAt = index.updatedAt ?? index.lastSaved ?? 0;
                  knownCloudProjectIndexes.set(key, index);
                  if (remoteRevision > localRevision) {
                      // Recover the one legacy failure mode where revision 1
                      // reached Firestore but the live iPhone editor remained
                      // at revision 0. All other newer remote revisions are a
                      // real conflict: never rebase them from timestamps alone,
                      // because device clocks can differ.
                      const canRecoverLostFirstRevision = localRevision === 0
                          && remoteRevision === 1
                          && project.lastSaved > remoteSavedAt;
                      if (!canRecoverLostFirstRevision) {
                          projectSyncConflicts.add(key);
                          reportWarning('sync-queue', 'Queued project conflicts with a newer cloud revision', {
                              projectId: job.projectId,
                              localRevision,
                              remoteRevision,
                          });
                          continue;
                      }
                      projectToSync = { ...project, cloudRevision: remoteRevision };
                  }
                  knownCloudRevisions.set(key, remoteRevision);
              }
          } catch (error) {
              reportWarning('sync-queue', 'Could not refresh the queued project revision before retry', {
                  projectId: job.projectId,
                  error: String(error),
              });
          }
          const result = await StorageService.saveProject(userId, projectToSync, true, false);
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
          if (isOwnedLocalProject(project, userId)) byId.set(project.projectId, project);
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
      // Only this account's local projects. The device may be shared, and
      // another account's copies (possibly with unsynced phone photos whose
      // only copy is in the asset store) must survive this account's wipe.
      const local = await StorageService.listProjectsLocal();
      const localProjects = await Promise.all(local.map(meta => StorageService.loadProjectLocal(meta.id)));
      const owned = localProjects.filter((project): project is MockupState => isOwnedLocalProject(project, userId));
      const kept = localProjects.filter((project): project is MockupState => !!project && !isOwnedLocalProject(project, userId));
      await Promise.all(owned.map(project => StorageService.deleteProjectLocal(project.projectId)));
      // deleteProjectLocal removes each project's own capture blobs. Sweep the
      // rest of the asset cache (e.g. cached cloud-drive images) except blobs
      // a remaining project still references.
      const stillReferenced = new Set(kept.flatMap(project => [
          ...collectSiteCaptureAssetRefs(project),
          ...collectHostedSiteCaptureRefs(project),
      ]));
      const assetKeys = await idbOperation<IDBValidKey[]>(STORE_ASSETS, 'readonly', store => store.getAllKeys());
      await Promise.all(assetKeys
          .filter(ref => !stillReferenced.has(String(ref)))
          .map(ref => idbOperation(STORE_ASSETS, 'readwrite', store => store.delete(ref))));
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
      const key = revisionKey(userId, projectId);
      const deletionEpoch = (projectDeletionEpochs.get(key) ?? 0) + 1;
      projectDeletionEpochs.set(key, deletionEpoch);
      deletedProjectKeys.add(key);
      // Reserve both slots synchronously. Saves invoked before this deletion
      // finish/abort first; saves invoked after it see the tombstone and cannot
      // recreate the Firestore document or its local state.
      const localReservation = reserveProjectLock(projectLocalSaveTails, key);
      const cloudReservation = reserveProjectLock(projectSaveTails, key);
      let authoritativeDeleted = false;
      try {
      await localReservation.waitForTurn;
      localReservation.release();
      await cloudReservation.waitForTurn;

      // Collect this project's drive refs BEFORE deleting the doc, so files
      // unique to it can be trashed from the user's drive afterwards.
      let deletedRefs: string[] = [];
      try {
          const snapshot = await getDoc(doc(db, FIRESTORE_COLLECTION, projectDocumentId(userId, projectId)));
          if (snapshot.exists()) deletedRefs = collectDriveRefs(await readCloudProjectState(snapshot.data() as CloudProjectIndex));
      } catch { /* best-effort */ }

      // The Firestore pointer is authoritative. If its deletion fails, abort
      // before touching Storage; otherwise a transient Firestore outage could
      // leave a live project document pointing at deleted state.
      await deleteDoc(doc(db, FIRESTORE_COLLECTION, projectDocumentId(userId, projectId)));
      authoritativeDeleted = true;
      knownCloudProjectIndexes.delete(key);
      knownCloudProjectIndexFetchedAt.delete(key);
      knownCloudRevisions.delete(key);
      projectSyncConflicts.delete(key);
      cloudProjectListRefreshedAt.set(userId, Date.now());
      latestProjectSaveSequences.delete(key);
      latestPersistedProjectSaveSequences.delete(key);
      latestProjectSaveTimestamps.delete(key);
      await pruneOrphanedImages(userId).catch(e => console.warn("Orphaned image prune failed:", e));
      await deleteStorageTree(storageRef(storage, `users/${userId}/captures/${projectId}`)).catch(e => console.warn('Site-capture cleanup failed:', e));
      await deleteStorageTree(storageRef(storage, projectStateRoot(userId, projectId))).catch(e => console.warn('Project-state cleanup failed:', e));

      // Trash drive files no other project still references (best-effort)
      if (deletedRefs.length > 0) {
          try {
              const snapshot = await getDocs(query(collection(db, FIRESTORE_COLLECTION), where('userId', '==', userId)));
              const stillReferenced = new Set<string>();
              for (const projectDoc of snapshot.docs) {
                  const project = await readCloudProjectState(projectDoc.data() as CloudProjectIndex);
                  collectDriveRefs(project).forEach(ref => stillReferenced.add(ref));
              }
              await Promise.all(deletedRefs.filter(ref => !stillReferenced.has(ref)).map(async ref => {
                  const connector = getConnectorForRef(ref);
                  if (connector && await connector.ensureReady(false).catch(() => false)) {
                      await connector.deleteImage(ref);
                      forgetKnownRef(ref);
                  }
              }));
          } catch (e) {
              console.warn("Drive image cleanup skipped:", e);
          }
      }
      } catch (error) {
          // A failed authoritative delete leaves the project valid. Allow a
          // later save/retry, but retain the incremented epoch so older work
          // that already observed this deletion cannot resume.
          if (!authoritativeDeleted && projectDeletionEpochs.get(key) === deletionEpoch) {
              deletedProjectKeys.delete(key);
          }
          throw error;
      } finally {
          localReservation.release();
          cloudReservation.release();
      }
  },

  saveProject: async (userId: string, state: MockupState, fromQueue = false, force = false): Promise<ProjectSaveResult> => {
      if (!userId.startsWith('guest_') && state.user?.uid !== userId) {
          reportWarning('sync-owner', 'Blocked a cloud save whose project owner does not match the active account', {
              projectId: state.projectId,
              userId,
              projectOwnerUid: state.user?.uid ?? null,
          });
          return 'error';
      }
      const key = revisionKey(userId, state.projectId);
      if (deletedProjectKeys.has(key)) return 'error';
      const deletionEpoch = projectDeletionEpochs.get(key) ?? 0;
      const saveSequence = (latestProjectSaveSequences.get(key) ?? 0) + 1;
      latestProjectSaveSequences.set(key, saveSequence);
      // Reserve both positions before the first await. Local writes use their
      // own short queue, so the newest phone edit becomes durable immediately
      // without waiting behind an older cloud upload. Cloud turns still retain
      // invocation order even when IndexedDB timings differ.
      const localReservation = reserveProjectLock(projectLocalSaveTails, key);
      const cloudReservation = reserveProjectLock(projectSaveTails, key);
      // Record when this snapshot actually entered persistence. Editor changes
      // can share the previous successful-save timestamp; giving every save a
      // monotonic edit timestamp lets restart logic prefer a newer local copy.
      const saveTimestamp = Math.max(
          (state.lastSaved ?? 0) + 1,
          (latestProjectSaveTimestamps.get(key) ?? 0) + 1,
          Date.now(),
      );
      latestProjectSaveTimestamps.set(key, saveTimestamp);
      state = { ...state, lastSaved: saveTimestamp };
      try {
          await localReservation.waitForTurn;
          if (deletedProjectKeys.has(key) || (projectDeletionEpochs.get(key) ?? 0) !== deletionEpoch) return 'error';
          try {
              if (userId.startsWith('guest_')) {
                  // A guest session must never overwrite a local project that a
                  // signed-in account now owns (e.g. a stale guest tab, or its
                  // sign-out flush, after the project was adopted by an account).
                  const existing = await StorageService.loadProjectLocal(state.projectId);
                  if (existing && !isOwnedLocalProject(existing, userId)) {
                      reportWarning('sync-owner', 'Blocked a guest save over an account-owned local project', {
                          projectId: state.projectId,
                          localOwnerUid: (existing as MockupState).user?.uid ?? null,
                      });
                      return 'error';
                  }
              }
              await StorageService.saveProjectLocal(state);
              latestPersistedProjectSaveSequences.set(key, saveSequence);
          } catch (e) {
              reportError('local-sync', e, { userId, projectId: state.projectId });
              return 'error';
          } finally {
              localReservation.release();
          }

          // Skip cloud sync for guest users
          if (userId.startsWith('guest_')) return 'local';
          if (deletedProjectKeys.has(key) || (projectDeletionEpochs.get(key) ?? 0) !== deletionEpoch) return 'error';
          if (!navigator.onLine) {
              if (!fromQueue) await StorageService.queueProjectSync(userId, state.projectId);
              return 'queued';
          }

          await cloudReservation.waitForTurn;
          if (deletedProjectKeys.has(key) || (projectDeletionEpochs.get(key) ?? 0) !== deletionEpoch) return 'error';
          if ((latestPersistedProjectSaveSequences.get(key) ?? 0) > saveSequence) return 'local';

      let pendingStatePath: string | null = null;
      const createdCaptureObjectPaths = new Set<string>();
      const pendingCaptureMappings = new Map<string, CaptureCloudRefMapping>();
      const uploadAttemptId = `${Date.now()}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      const removeCreatedCaptureObjects = async () => {
          const paths = [...createdCaptureObjectPaths];
          if (!paths.length) return;
          await Promise.all(paths.map(path => deleteObject(storageRef(storage, path)).catch(error => {
              reportWarning('capture-upload-cleanup', 'Abandoned cloud capture cleanup failed', {
                  projectId: state.projectId,
                  path,
                  error: String(error),
              });
          })));
          createdCaptureObjectPaths.clear();
      };
      try {
          const baseRevision = knownCloudRevisions.get(key) ?? state.cloudRevision ?? 0;
          const cachedIndex = knownCloudProjectIndexes.get(key);
          // A known index is safe to reuse because the Firestore transaction
          // below verifies both its revision and immutable state pointer. A
          // genuinely new local project can likewise assume "absent" and let
          // the transaction reject that assumption if another device already
          // created the same id. This avoids a redundant server round-trip on
          // every iPhone autosave without weakening stale-object protection.
          const authoritativeCaptureState = !force && cachedIndex?.statePath
              && (cachedIndex.cloudRevision ?? 0) === baseRevision
              ? await captureRetentionStateFromIndex(userId, state.projectId, cachedIndex)
              : !force && !cachedIndex && baseRevision === 0
                  ? {
                      revision: 0,
                      currentObjectPaths: new Set<string>(),
                      retainedObjectPaths: new Set<string>(),
                      expectedExists: false,
                    }
                  : await readAuthoritativeCloudCaptureState(userId, state.projectId);
          if (!force && authoritativeCaptureState.revision > baseRevision) {
              projectSyncConflicts.add(key);
              return 'conflict';
          }
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

          const logoImage = state.titleBlock.logoImage ? await resolveImage(state.titleBlock.logoImage) : null;

          // Reference images were previously synced as raw data URIs — a
          // Firestore 1MB-per-doc time bomb. Route them through the same pipeline.
          const referenceImages = await Promise.all((state.referenceImages ?? []).map(async r => ({
              ...r,
              image: await resolveImage(r.image),
          })));

          const settleCaptureUploads = async <T,>(promises: Promise<T>[]): Promise<T[]> => {
              const results = await Promise.allSettled(promises);
              const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
              if (failed) throw failed.reason;
              return results.map(result => (result as PromiseFulfilledResult<T>).value);
          };
          const siteCaptures = await settleCaptureUploads((state.siteCaptures ?? []).map(async capture => ({
              ...capture,
              originalRef: await uploadSiteCaptureAsset(userId, state.projectId, capture.id, 'original', capture.originalRef, createdCaptureObjectPaths, uploadAttemptId, authoritativeCaptureState.retainedObjectPaths, pendingCaptureMappings),
              annotationBaseRef: capture.annotationBaseRef
                  ? await uploadSiteCaptureAsset(userId, state.projectId, capture.id, 'annotation-base', capture.annotationBaseRef, createdCaptureObjectPaths, uploadAttemptId, authoritativeCaptureState.retainedObjectPaths, pendingCaptureMappings)
                  : undefined,
              workingRef: await uploadSiteCaptureAsset(userId, state.projectId, capture.id, 'working', capture.workingRef, createdCaptureObjectPaths, uploadAttemptId, authoritativeCaptureState.retainedObjectPaths, pendingCaptureMappings),
              thumbnailRef: await uploadSiteCaptureAsset(userId, state.projectId, capture.id, 'thumbnail', capture.thumbnailRef, createdCaptureObjectPaths, uploadAttemptId, authoritativeCaptureState.retainedObjectPaths, pendingCaptureMappings),
              supportingPhotos: await settleCaptureUploads((capture.supportingPhotos ?? []).map(async photo => ({
                  ...photo,
                  originalRef: await uploadSiteCaptureAsset(userId, state.projectId, photo.id, 'original', photo.originalRef, createdCaptureObjectPaths, uploadAttemptId, authoritativeCaptureState.retainedObjectPaths, pendingCaptureMappings),
                  workingRef: await uploadSiteCaptureAsset(userId, state.projectId, photo.id, 'working', photo.workingRef, createdCaptureObjectPaths, uploadAttemptId, authoritativeCaptureState.retainedObjectPaths, pendingCaptureMappings),
                  thumbnailRef: await uploadSiteCaptureAsset(userId, state.projectId, photo.id, 'thumbnail', photo.thumbnailRef, createdCaptureObjectPaths, uploadAttemptId, authoritativeCaptureState.retainedObjectPaths, pendingCaptureMappings),
              }))),
          })));

          const promotedCaptureBackgrounds = new Map(
              state.canvases.flatMap(canvas => {
                  const capture = siteCaptures.find(candidate => candidate.promotedCanvasId === canvas.id
                      && canvas.siteCaptureLink?.captureId === candidate.id
                      && canvas.siteCaptureLink.annotationUpdatedAt === (candidate.annotationUpdatedAt ?? candidate.capturedAt));
                  return capture ? [[canvas.id, capture.workingRef] as const] : [];
              }),
          );
          const canvases = await Promise.all(state.canvases.map(async canvas => ({
              ...canvas,
              // A promoted site photo already has an immutable capture object.
              // Reuse it instead of uploading another full marked image into
              // the generic content-addressed image tree on every edit.
              backgroundImage: promotedCaptureBackgrounds.get(canvas.id) ?? await resolveImage(canvas.backgroundImage),
              signs: await Promise.all(canvas.signs.map(async sign => ({
                  ...sign,
                  image: await resolveImage(sign.image),
              }))),
          })));

          const cloudState = {
              ...state,
              canvases,
              titleBlock: { ...state.titleBlock, logoImage },
              referenceImages,
              siteCaptures,
          };

          // Store full editor state as versioned JSON in the user's protected
          // Storage folder. Firestore remains a small queryable index and
          // revision pointer, so complex/large projects cannot violate its
          // nested-array or 1 MiB document restrictions.
          const stateVersion = `${Date.now()}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
          const serializedState = await serializeCloudProjectState(cloudState);
          pendingStatePath = `${projectStateRoot(userId, state.projectId)}/revisions/${stateVersion}.${serializedState.encoding === 'gzip' ? 'json.gz' : 'json'}`;
          const projectStateRef = storageRef(storage, pendingStatePath);
           await uploadBytes(projectStateRef, serializedState.blob, {
               contentType: serializedState.encoding === 'gzip' ? 'application/gzip' : 'application/json',
           });
           const stateUrl = await getDownloadURL(projectStateRef);

           if (deletedProjectKeys.has(key)
               || (projectDeletionEpochs.get(key) ?? 0) !== deletionEpoch
               || (latestPersistedProjectSaveSequences.get(key) ?? 0) > saveSequence) {
                await deleteObject(projectStateRef).catch(() => undefined);
                pendingStatePath = null;
                await removeCreatedCaptureObjects();
                return deletedProjectKeys.has(key) ? 'error' : 'local';
           }

           const projectRef = doc(db, FIRESTORE_COLLECTION, projectDocumentId(userId, state.projectId));
          const transactionResult = await runTransaction(db, async transaction => {
              const remote = await transaction.get(projectRef);
              const remoteData = remote.exists() ? remote.data() as CloudProjectIndex : undefined;
              const remoteRevision = remoteData?.cloudRevision ?? 0;
              // Any change after the asset preflight must restart the save.
              // This guarantees that obsolete hosted refs are either retained
              // or copied before a forced restore can commit them again.
              if (remoteRevision !== authoritativeCaptureState.revision
                  || remote.exists() !== authoritativeCaptureState.expectedExists
                  || (authoritativeCaptureState.expectedStatePath !== undefined
                      && remoteData?.statePath !== authoritativeCaptureState.expectedStatePath)) return null;
              const revision = remoteRevision + 1;
              const obsoleteState: CloudStatePointer | null = remoteData?.previousStatePath ? {
                  path: remoteData.previousStatePath,
                  url: remoteData.previousStateUrl,
                  encoding: remoteData.previousStateEncoding,
              } : null;
              const captureObjectPaths = [
                  ...collectCloudSiteCaptureObjectPaths(
                      cloudState,
                      captureProjectObjectPrefix(userId, state.projectId),
                  ),
              ];
              const index: CloudProjectIndex = {
                  schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
                  statePath: pendingStatePath,
                  stateUrl,
                  stateEncoding: serializedState.encoding,
                  // Keep the immediately preceding revision available. A
                  // device that listed just before this commit can still open
                  // it, then refresh its index. Delete only the revision that
                  // is now two generations old.
                  previousStatePath: remoteData?.statePath,
                  previousStateUrl: remoteData?.stateUrl,
                  previousStateEncoding: remoteData?.stateEncoding,
                  previousStateRevision: remoteData?.cloudRevision,
                  captureObjectPaths,
                  previousCaptureObjectPaths: [...authoritativeCaptureState.currentObjectPaths],
                  userId,
                  projectId: state.projectId,
                  projectName: state.projectName,
                  // Sort by when the user edited the project, not when a slow
                  // network request happened to finish. This prevents an old
                  // in-flight save from replacing the current project on boot.
                  updatedAt: state.lastSaved ?? Date.now(),
                  lastSaved: state.lastSaved,
                  cloudRevision: revision,
                  canvasCount: canvases.length,
                  hasImage: canvases.some(canvas => Boolean(canvas.backgroundImage || canvas.signs.some(sign => sign.image))),
              };
              const firestoreIndex = withoutUndefined(index) as CloudProjectIndex;
              transaction.set(projectRef, firestoreIndex);
              return {
                  revision,
                  obsoleteState,
                  obsoleteCaptureObjectPaths: remoteData?.previousCaptureObjectPaths,
                  index: firestoreIndex,
              };
          });
          if (transactionResult === null) {
              await deleteObject(storageRef(storage, pendingStatePath)).catch(() => undefined);
              pendingStatePath = null;
              await removeCreatedCaptureObjects();
              if (!fromQueue) await StorageService.queueProjectSync(userId, state.projectId);
              return 'queued';
          }
          // The Firestore pointer now owns these objects. Later local/cache
          // bookkeeping failures must never delete assets from the committed
          // cloud revision.
          createdCaptureObjectPaths.clear();
          await putCaptureCloudRefMappings(pendingCaptureMappings.values()).catch(error => {
              reportWarning('capture-ref-mapping', 'Committed capture-reference mapping could not be cached', {
                  projectId: state.projectId,
                  error: String(error),
              });
          });
          const committedStatePath = pendingStatePath;
           pendingStatePath = null;
           knownCloudRevisions.set(key, transactionResult.revision);
           knownCloudProjectIndexes.set(key, transactionResult.index);
           knownCloudProjectIndexFetchedAt.set(key, Date.now());
           projectSyncConflicts.delete(key);
           // A newer invocation may already have written a fresher local
           // snapshot while this upload was running. Never overwrite it with
           // this older state just to record the cloud revision.
           {
               const revisionReservation = reserveProjectLock(projectLocalSaveTails, key);
               await revisionReservation.waitForTurn;
               try {
                   const stillCurrentProject = !deletedProjectKeys.has(key)
                       && (projectDeletionEpochs.get(key) ?? 0) === deletionEpoch;
                   if (stillCurrentProject && latestPersistedProjectSaveSequences.get(key) === saveSequence) {
                       await StorageService.saveProjectLocal({ ...state, cloudRevision: transactionResult.revision });
                   } else if (stillCurrentProject) {
                       // A newer snapshot of the same editor session reached
                       // IndexedDB while this upload ran. Its content descends
                       // from the revision just committed, so record that
                       // revision as its base. Otherwise it keeps the old base:
                       // after an app kill, reload would see "local older than
                       // cloud" and replace the newer edits with this commit.
                       const newer = await StorageService.loadProjectLocal(state.projectId);
                       if (newer && newer.user?.uid === userId
                           && (newer.cloudRevision ?? 0) < transactionResult.revision) {
                           await StorageService.saveProjectLocal({ ...newer, cloudRevision: transactionResult.revision });
                       }
                   }
               } finally {
                   revisionReservation.release();
               }
           }
           if (latestPersistedProjectSaveSequences.get(key) === saveSequence) {
               await idbOperation(STORE_SYNC_QUEUE, 'readwrite', store => store.delete(state.projectId));
           }

          if (transactionResult.obsoleteState && transactionResult.obsoleteState.path !== committedStatePath) {
              await pruneSupersededCloudCaptureAssets(
                  userId,
                  state.projectId,
                  transactionResult.obsoleteState,
                  transactionResult.obsoleteCaptureObjectPaths,
              ).catch(error => {
                  reportWarning('capture-cloud-cleanup', 'Superseded cloud capture cleanup failed', {
                      projectId: state.projectId,
                      error: String(error),
                  });
              });
              await deleteObject(storageRef(storage, transactionResult.obsoleteState.path)).catch(error => {
                  reportWarning('project-state-cleanup', 'Old cloud project revision cleanup failed', {
                      projectId: state.projectId,
                      error: String(error),
                  });
              });
          }

          return 'cloud';
      } catch (e) {
          if (pendingStatePath) await deleteObject(storageRef(storage, pendingStatePath)).catch(() => undefined);
          await removeCreatedCaptureObjects();
          reportError('firestore-sync', e, { userId, projectId: state.projectId, permissionDenied: (e as any)?.code === 'permission-denied' });
          if (fromQueue) return 'queued';
          try {
              await StorageService.queueProjectSync(userId, state.projectId);
              return 'queued';
          } catch (queueError) {
              reportError('sync-queue', queueError, { userId, projectId: state.projectId });
              return 'local';
          }
       }
       } finally {
           localReservation.release();
           cloudReservation.release();
       }
   },

  listProjectsCloud: async (userId: string, throwOnError = false): Promise<ProjectMetadata[]> => {
      if (userId.startsWith('guest_')) return [];
      try {
          // No orderBy — combining `where` with `orderBy` on a different field
          // requires a composite Firestore index to be deployed first, and fails
          // silently (empty list) until that index exists. Sorting client-side
          // needs only the automatic single-field index Firestore always has.
          // Strict auth/discovery reads must never interpret an offline cache
          // miss as an authoritative empty account. Ordinary project-manager
          // reads may still use Firestore's normal cache-first fallback.
          // No limit either: without orderBy, Firestore returns documents in
          // document-id order, and ids end in a creation timestamp — so a
          // limit kept the OLDEST projects and hid all recent work once an
          // account passed it. Index documents are tiny (the full state lives
          // in Storage), so reading all of them is cheap.
          const readProjects = throwOnError ? getDocsFromServer : getDocs;
          const snapshot = await readProjects(query(collection(db, FIRESTORE_COLLECTION), where('userId', '==', userId)));

          const seen = new Set<string>();
          const projects = snapshot.docs.map(doc => {
               const d = doc.data();
               const key = revisionKey(userId, d.projectId);
               seen.add(key);
               knownCloudProjectIndexes.set(key, d as CloudProjectIndex);
               knownCloudProjectIndexFetchedAt.set(key, Date.now());
              return {
                  id: d.projectId,
                  name: d.projectName ?? 'Untitled Project',
                  lastModified: d.updatedAt ?? d.lastSaved,
                  canvasCount: d.canvasCount ?? d.canvases?.length ?? 1,
              };
          }).sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
           for (const [key, index] of knownCloudProjectIndexes) {
               if (index.userId === userId && !seen.has(key)) {
                   knownCloudProjectIndexes.delete(key);
                   knownCloudProjectIndexFetchedAt.delete(key);
               }
          }
          cloudProjectListRefreshedAt.set(userId, Date.now());
          return projects;
      } catch (e) {
          reportError('firestore-list', e, { userId, permissionDenied: (e as any)?.code === 'permission-denied' });
          if (throwOnError) throw e;
          return [];
      }
  },

  loadProjectCloud: async (
      userId: string,
      projectId: string,
      onResolveIssues?: (r: Pick<ResolveResult, 'failedRefs' | 'needsReconnect'>) => void,
      forceRefresh = false,
      throwOnError = false,
  ): Promise<MockupState | null> => {
      if (userId.startsWith('guest_')) return null;
       try {
           const key = revisionKey(userId, projectId);
           let index = forceRefresh ? undefined : knownCloudProjectIndexes.get(key);
           const cachedAt = knownCloudProjectIndexFetchedAt.get(key) ?? 0;
           // A network list/save may hand its index to the immediately following
           // load once. Cached lists shown later must re-check Firestore so a
           // still-valid retained revision cannot remain stale indefinitely.
           const usedCachedIndex = Boolean(index && Date.now() - cachedAt <= 1_000);
           if (usedCachedIndex) knownCloudProjectIndexFetchedAt.delete(key);
           else index = undefined;
           if (!index) {
               const readIndex = forceRefresh || throwOnError ? getDocFromServer : getDoc;
               const snapshot = await readIndex(doc(db, FIRESTORE_COLLECTION, projectDocumentId(userId, projectId)));
               if (!snapshot.exists()) {
                   knownCloudProjectIndexes.delete(key);
                   knownCloudProjectIndexFetchedAt.delete(key);
                   return null;
               }
               index = snapshot.data() as CloudProjectIndex;
               knownCloudProjectIndexes.set(key, index);
           }
          let projectState: MockupState;
          try {
              projectState = await readCloudProjectState(index);
          } catch (cachedError) {
              if (!usedCachedIndex) throw cachedError;
              // The cached pointer may have been superseded and aged out by
              // another device. Refresh once and retry the authoritative path.
              const snapshot = await getDocFromServer(doc(db, FIRESTORE_COLLECTION, projectDocumentId(userId, projectId)));
               if (!snapshot.exists()) {
                   knownCloudProjectIndexes.delete(key);
                   knownCloudProjectIndexFetchedAt.delete(key);
                   return null;
               }
              index = snapshot.data() as CloudProjectIndex;
              knownCloudProjectIndexes.set(key, index);
              projectState = await readCloudProjectState(index);
           }
           // A device that has opened the project must be able to keep its
           // local copy even after later revisions age old cloud objects out.
           // Cache every hosted capture blob before treating the cloud load as
           // successful; stale-ref rehoming reads this durable cache first.
           await cacheHostedSiteCaptureAssets(projectState);
           // Deliberately do NOT advance knownCloudRevisions here. Reading the
           // cloud copy is not adopting it: callers that keep the local copy
           // (queued edits, conflict checks, exports) must still save against
           // their own base so a newer remote revision surfaces as a conflict
           // instead of being silently overwritten. Adopting callers use
           // adoptCloudRevision().

          // Materialize any cloud-drive refs into displayable data URIs
          const resolved = await resolveProjectImages(projectState);
          if (resolved.failedRefs.length > 0) {
              onResolveIssues?.({ failedRefs: resolved.failedRefs, needsReconnect: resolved.needsReconnect });
          }
          return resolved.state;
      } catch (e) {
          reportError('firestore-load', e, { userId, projectId, permissionDenied: (e as any)?.code === 'permission-denied' });
          if (throwOnError) throw e;
          return null;
      }
  },
};
