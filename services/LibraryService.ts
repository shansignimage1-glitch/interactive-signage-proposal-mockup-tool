import { db, storage } from '../firebase';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, query, setDoc, where } from 'firebase/firestore';
import { deleteObject, getDownloadURL, listAll, ref as storageRef, uploadBytes } from 'firebase/storage';
import { SignTemplate, SignType } from '../types';
import { hashDataUri, dataUriToBlob } from './imageHash';
import { resolveRef, isDriveRef } from './AssetResolver';

// Cloud sign library:
//   - `library` (Firestore) + `library/{hash}` (Storage): shared company
//     catalog, readable by all signed-in users, writable only by the admin
//     (enforced by security rules — the email below is just for showing/hiding
//     admin UI).
//   - `userLibrary` (Firestore) + `users/{uid}/library/{hash}` (Storage):
//     each user's personal templates.
// Images are stored as Storage download URLs, so <img> can hot-link them.

export const isLibraryAdmin = (user?: { isAdmin?: boolean } | null): boolean => user?.isAdmin === true;

const SHARED_COLLECTION = 'library';
const PERSONAL_COLLECTION = 'userLibrary';

export interface NewTemplateInput {
    name: string;
    category: string;
    widthMm: number;
    heightMm: number;
    dataUri: string;
    brand?: string;
    tags?: string[];
    signType?: SignType;
    rightsNote?: string;
}

let sharedCache: SignTemplate[] | null = null;
const templateImageCache = new Map<string, Promise<string>>();
const templateDownloadUrlCache = new Map<string, string>();
const TEMPLATE_IMAGE_TIMEOUT_MS = 15_000;
const LIBRARY_METADATA_TIMEOUT_MS = 12_000;
const PERSONAL_RECOVERY_TIMEOUT_MS = 5_000;
const MAX_TEMPLATE_IMAGE_CACHE_ENTRIES = 32;

const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        promise.then(
            value => { window.clearTimeout(timer); resolve(value); },
            error => { window.clearTimeout(timer); reject(error); },
        );
    });

const storagePathFromUrl = (imageUrl: string): string | undefined => {
    try {
        const match = new URL(imageUrl).pathname.match(/\/o\/([^/]+)$/);
        return match ? decodeURIComponent(match[1]) : undefined;
    } catch {
        return undefined;
    }
};

const docToTemplate = (id: string, d: any, source: 'shared' | 'personal'): SignTemplate => ({
    id: `${source}_${id}`,
    docId: id,
    name: d.name ?? 'Untitled',
    category: d.category ?? 'Fascia',
    image: d.imageUrl ?? '',
    width: d.widthMm ?? 2000,
    height: d.heightMm ?? 500,
    source,
    // Older records may only contain a Firebase download URL. Recover the
    // stable object path so revoked/rotated download tokens can be refreshed.
    storagePath: d.storagePath ?? storagePathFromUrl(d.imageUrl ?? ''),
    ownerUid: d.ownerUid,
    brand: d.brand,
    tags: d.tags ?? [],
    signType: d.signType,
    rightsNote: d.rightsNote,
    version: d.version ?? 1,
    updatedAt: d.updatedAt,
    deleting: d.deleting === true,
    deletionId: d.deletionId,
});

const uploadLibraryImage = async (storagePath: string, dataUri: string): Promise<string> => {
    const imageRef = storageRef(storage, storagePath);
    try {
        return await getDownloadURL(imageRef); // content-addressed: may already exist
    } catch {
        await uploadBytes(imageRef, dataUriToBlob(dataUri));
        return await getDownloadURL(imageRef);
    }
};

// Turns whatever the active sign currently holds into an uploadable data URI.
export const materializeDataUri = async (image: string): Promise<string> => {
    if (image.startsWith('data:')) return image;
    if (isDriveRef(image)) return resolveRef(image);
    const res = await fetch(image);
    if (!res.ok) throw new Error(`Could not fetch sign image (${res.status})`);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
};

export const refreshTemplateImageUrl = async (template: SignTemplate): Promise<string> => {
    if (!template.storagePath) return template.image;
    const imageUrl = await withTimeout(
        getDownloadURL(storageRef(storage, template.storagePath)),
        LIBRARY_METADATA_TIMEOUT_MS,
        `Refreshing ${template.name}`,
    );
    templateDownloadUrlCache.set(template.storagePath, imageUrl);
    return imageUrl;
};

const loadTemplateDataUri = async (template: SignTemplate): Promise<string> => {
    let firstError: unknown;
    const cachedUrl = template.storagePath ? templateDownloadUrlCache.get(template.storagePath) : undefined;
    const initialUrl = cachedUrl ?? template.image;

    // Persisted Firebase download URLs are token-authenticated and do not need
    // the signed-in user's auth token. Prefer that browser-compatible path.
    if (initialUrl) {
        try {
            return await withTimeout(
                materializeDataUri(initialUrl),
                TEMPLATE_IMAGE_TIMEOUT_MS,
                `Loading ${template.name}`,
            );
        } catch (error) {
            firstError = error;
            if (template.storagePath) templateDownloadUrlCache.delete(template.storagePath);
        }
    }

    // Older records may hold a revoked token. Resolve a fresh URL through the
    // stable Storage path, then retry the normal browser download path.
    if (template.storagePath) {
        try {
            const refreshedUrl = await refreshTemplateImageUrl(template);
            if (refreshedUrl) {
                return await withTimeout(
                    materializeDataUri(refreshedUrl),
                    TEMPLATE_IMAGE_TIMEOUT_MS,
                    `Loading ${template.name}`,
                );
            }
        } catch (error) {
            if (!firstError) firstError = error;
        }
    }

    throw firstError instanceof Error ? firstError : new Error(`Could not load ${template.name}`);
};

// Materialize only when the canvas needs a self-contained image. Library cards
// render their download URL directly and avoid a redundant authenticated blob
// download for every thumbnail.
export const materializeTemplateDataUri = async (template: SignTemplate): Promise<string> => {
    if (template.image.startsWith('data:')) return template.image;
    const cacheKey = template.storagePath ?? template.image;
    if (cacheKey) {
        const cached = templateImageCache.get(cacheKey);
        if (cached) {
            templateImageCache.delete(cacheKey);
            templateImageCache.set(cacheKey, cached);
            return cached;
        }
        const loading = loadTemplateDataUri(template).catch(error => {
            templateImageCache.delete(cacheKey);
            throw error;
        });
        if (templateImageCache.size >= MAX_TEMPLATE_IMAGE_CACHE_ENTRIES) {
            const oldest = templateImageCache.keys().next().value;
            if (oldest) templateImageCache.delete(oldest);
        }
        templateImageCache.set(cacheKey, loading);
        return loading;
    }
    throw new Error(`Could not load ${template.name}`);
};

const deleteStoragePath = async (storagePath: string): Promise<void> => {
    try {
        await deleteObject(storageRef(storage, storagePath));
    } catch (error) {
        if ((error as { code?: string })?.code !== 'storage/object-not-found') throw error;
    }
};

const createOperationId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
};

const recoverPersonalUploads = async (uid: string, known: SignTemplate[]): Promise<SignTemplate[]> => {
    const knownPaths = new Set(known.map(template => template.storagePath).filter(Boolean));
    // Finish any cross-service deletion that was interrupted after its
    // Firestore tombstone was written. Failures remain tombstoned and retry on
    // the next open instead of resurfacing as recovered uploads.
    await Promise.allSettled(known.filter(template => template.deleting).map(async template => {
        if (!template.docId || !template.deletionId) return;
        const templateDoc = doc(db, PERSONAL_COLLECTION, template.docId);
        const beforeDelete = await getDoc(templateDoc);
        const beforeData = beforeDelete.exists() ? beforeDelete.data() : null;
        if (!beforeData || beforeData.deleting !== true || beforeData.deletionId !== template.deletionId) return;
        if (template.storagePath) await deleteStoragePath(template.storagePath);
        const afterDelete = await getDoc(templateDoc);
        const afterData = afterDelete.exists() ? afterDelete.data() : null;
        if (afterData?.deleting === true && afterData.deletionId === template.deletionId) {
            await deleteDoc(templateDoc);
        }
    })).then(results => {
        results.forEach(result => {
            if (result.status === 'rejected') console.warn('Personal library deletion cleanup will retry:', result.reason);
        });
    });
    const folder = storageRef(storage, `users/${uid}/library`);
    const listing = await withTimeout(
        listAll(folder),
        PERSONAL_RECOVERY_TIMEOUT_MS,
        'Checking uploaded signs',
    );

    const orphanRefs = listing.items
        .filter(item => !knownPaths.has(item.fullPath))
        .sort((a, b) => a.name.localeCompare(b.name));

    return Promise.all(orphanRefs.map(async (item, index): Promise<SignTemplate> => {
        let image = '';
        try {
            image = await withTimeout(
                getDownloadURL(item),
                PERSONAL_RECOVERY_TIMEOUT_MS,
                'Recovering an uploaded sign',
            );
        } catch (error) {
            console.warn(`Personal library upload ${item.fullPath} could not be recovered:`, error);
        }
        // Keep even a temporarily unavailable object visible. Its thumbnail
        // and selection path can retry through storagePath, and the user can
        // still delete it instead of having it silently disappear.
        return {
            id: `personal_${uid}_${item.name}`,
            name: `Recovered upload ${index + 1}`,
            category: 'Recovered',
            image,
            // The exact ratio is read from the materialized image when it is
            // placed; these neutral values are not presented as mm.
            width: 1,
            height: 1,
            source: 'personal',
            storagePath: item.fullPath,
            ownerUid: uid,
            tags: ['recovered'],
            recovered: true,
        };
    }));
};

export const LibraryService = {

    listShared: async (): Promise<SignTemplate[]> => {
        if (sharedCache) return sharedCache;
        const snapshot = await withTimeout(
            getDocs(query(collection(db, SHARED_COLLECTION), limit(200))),
            LIBRARY_METADATA_TIMEOUT_MS,
            'Loading Shared Library',
        );
        sharedCache = snapshot.docs
            .map(doc => docToTemplate(doc.id, doc.data(), 'shared'))
            .sort((a, b) => a.name.localeCompare(b.name));
        return sharedCache;
    },

    listPersonal: async (uid: string): Promise<SignTemplate[]> => {
        if (uid.startsWith('guest_')) return [];
        // No orderBy — avoids needing a composite index; sort client-side
        const snapshot = await withTimeout(
            getDocs(query(collection(db, PERSONAL_COLLECTION), where('ownerUid', '==', uid), limit(200))),
            LIBRARY_METADATA_TIMEOUT_MS,
            'Loading My Library',
        );
        return snapshot.docs
            .map(doc => docToTemplate(doc.id, doc.data(), 'personal'))
            .sort((a, b) => a.name.localeCompare(b.name));
    },

    // Recovery is intentionally separate from listPersonal so valid metadata
    // appears immediately even if Storage listing is slow or unavailable.
    recoverPersonalUploads: async (uid: string, known: SignTemplate[]): Promise<SignTemplate[]> => {
        if (uid.startsWith('guest_')) return [];
        return recoverPersonalUploads(uid, known);
    },

    saveToPersonal: async (uid: string, input: NewTemplateInput): Promise<SignTemplate> => {
        const hash = await hashDataUri(input.dataUri);
        // Each save gets its own path and document. This prevents cleanup of a
        // tombstoned upload from racing with a new save of identical artwork.
        const uploadId = createOperationId();
        const storagePath = `users/${uid}/library/${hash}_${uploadId}`;
        const imageUrl = await uploadLibraryImage(storagePath, input.dataUri);

        const docId = `${uid}_${hash}_${uploadId}`;
        const data = {
            name: input.name,
            category: input.category,
            widthMm: input.widthMm,
            heightMm: input.heightMm,
            imageUrl,
            storagePath,
            ownerUid: uid,
            createdAt: Date.now(),
            brand: input.brand ?? '', tags: input.tags ?? [], signType: input.signType ?? 'fascia_non_ill', rightsNote: input.rightsNote ?? '', version: 1, updatedAt: Date.now(),
        };
        await setDoc(doc(db, PERSONAL_COLLECTION, docId), data);
        return { ...docToTemplate(docId, data, 'personal'), image: input.dataUri };
    },

    deletePersonal: async (template: SignTemplate): Promise<void> => {
        if (!template.docId && !template.storagePath) return;
        if (template.docId) {
            // A tombstone keeps recovery from rediscovering the object if
            // either half of this cross-service deletion needs to be retried.
            const deletionId = createOperationId();
            await setDoc(doc(db, PERSONAL_COLLECTION, template.docId), {
                deleting: true,
                deletionId,
                updatedAt: Date.now(),
            }, { merge: true });
        }
        // Delete Storage first and surface failures. Otherwise a failed object
        // delete followed by a successful metadata delete would be recovered
        // as an apparent new upload on the next library load.
        if (template.storagePath) await deleteStoragePath(template.storagePath);
        // Recovered uploads have no Firestore record, so the Storage delete is
        // sufficient. If this metadata delete fails, the tombstone makes the
        // next attempt safe and keeps the broken record out of recovery.
        if (template.docId) await deleteDoc(doc(db, PERSONAL_COLLECTION, template.docId));
    },

    // Admin-only (security rules enforce; UI hides it for everyone else)
    saveToShared: async (input: NewTemplateInput): Promise<SignTemplate> => {
        const hash = await hashDataUri(input.dataUri);
        const storagePath = `library/${hash}`;
        const imageUrl = await uploadLibraryImage(storagePath, input.dataUri);

        const data = {
            name: input.name,
            category: input.category,
            widthMm: input.widthMm,
            heightMm: input.heightMm,
            imageUrl,
            storagePath,
            createdAt: Date.now(),
            brand: input.brand ?? '', tags: input.tags ?? [], signType: input.signType ?? 'fascia_non_ill', rightsNote: input.rightsNote ?? '', version: 1, updatedAt: Date.now(),
        };
        const docRef = await addDoc(collection(db, SHARED_COLLECTION), data);
        sharedCache = null; // refetch next time
        return { ...docToTemplate(docRef.id, data, 'shared'), image: input.dataUri };
    },

    updateShared: async (template: SignTemplate, input: NewTemplateInput): Promise<SignTemplate> => {
        if (!template.docId) throw new Error('Template document is missing');
        const replacingImage = input.dataUri.startsWith('data:');
        const hash = replacingImage ? await hashDataUri(input.dataUri) : null;
        const storagePath = hash ? `library/${hash}` : template.storagePath;
        const imageUrl = hash ? await uploadLibraryImage(storagePath!, input.dataUri) : template.image;
        const data: Record<string, unknown> = {
            name: input.name, category: input.category, widthMm: input.widthMm, heightMm: input.heightMm,
            imageUrl, brand: input.brand ?? '', tags: input.tags ?? [], signType: input.signType ?? 'fascia_non_ill',
            rightsNote: input.rightsNote ?? '', version: (template.version ?? 1) + 1, updatedAt: Date.now(),
        };
        if (storagePath) data.storagePath = storagePath;
        await setDoc(doc(db, SHARED_COLLECTION, template.docId), data, { merge: true });
        // Shared objects are content-addressed and immutable. Keep the old
        // object: another current or legacy record may still reference it.
        sharedCache = null;
        return { ...docToTemplate(template.docId, data, 'shared'), image: replacingImage ? input.dataUri : template.image };
    },

    deleteShared: async (template: SignTemplate): Promise<void> => {
        if (!template.docId) return;
        await deleteDoc(doc(db, SHARED_COLLECTION, template.docId));
        // Do not delete the content-addressed object here. Multiple records can
        // legitimately share it, including legacy records without storagePath.
        sharedCache = null;
    },

    invalidateCache: (): void => {
        sharedCache = null;
        templateImageCache.clear();
        templateDownloadUrlCache.clear();
    },
};
