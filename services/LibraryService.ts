import { db, storage } from '../firebase';
import { addDoc, collection, deleteDoc, doc, getDocs, limit, query, setDoc, where } from 'firebase/firestore';
import { deleteObject, getBlob, getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage';
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
const TEMPLATE_IMAGE_TIMEOUT_MS = 15_000;
const LIBRARY_METADATA_TIMEOUT_MS = 12_000;
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

const blobToDataUri = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
});

// Library objects have stable Storage paths even when their persisted public
// download token has expired. Read through the authenticated Firebase SDK.
export const materializeTemplateDataUri = async (template: SignTemplate): Promise<string> => {
    if (template.image.startsWith('data:')) return template.image;
    if (template.storagePath) {
        const cached = templateImageCache.get(template.storagePath);
        if (cached) {
            templateImageCache.delete(template.storagePath);
            templateImageCache.set(template.storagePath, cached);
            return cached;
        }
        const loading = withTimeout(
            getBlob(storageRef(storage, template.storagePath)),
            TEMPLATE_IMAGE_TIMEOUT_MS,
            `Loading ${template.name}`,
        ).then(blobToDataUri).catch(error => {
            templateImageCache.delete(template.storagePath!);
            throw error;
        });
        if (templateImageCache.size >= MAX_TEMPLATE_IMAGE_CACHE_ENTRIES) {
            const oldest = templateImageCache.keys().next().value;
            if (oldest) templateImageCache.delete(oldest);
        }
        templateImageCache.set(template.storagePath, loading);
        return loading;
    }
    return withTimeout(materializeDataUri(template.image), TEMPLATE_IMAGE_TIMEOUT_MS, `Loading ${template.name}`);
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

    saveToPersonal: async (uid: string, input: NewTemplateInput): Promise<SignTemplate> => {
        const hash = await hashDataUri(input.dataUri);
        const storagePath = `users/${uid}/library/${hash}`;
        const imageUrl = await uploadLibraryImage(storagePath, input.dataUri);

        const docId = `${uid}_${hash}`; // natural dedupe: same image saved twice = same doc
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
        if (!template.docId) return;
        await deleteDoc(doc(db, PERSONAL_COLLECTION, template.docId));
        if (template.storagePath) {
            await deleteObject(storageRef(storage, template.storagePath))
                .catch(e => console.warn('Library image delete skipped:', e));
        }
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
        if (replacingImage && template.storagePath && template.storagePath !== storagePath) await deleteObject(storageRef(storage, template.storagePath)).catch(() => undefined);
        sharedCache = null;
        return { ...docToTemplate(template.docId, data, 'shared'), image: replacingImage ? input.dataUri : template.image };
    },

    deleteShared: async (template: SignTemplate): Promise<void> => {
        if (!template.docId) return;
        await deleteDoc(doc(db, SHARED_COLLECTION, template.docId));
        if (template.storagePath) {
            await deleteObject(storageRef(storage, template.storagePath))
                .catch(e => console.warn('Library image delete skipped:', e));
        }
        sharedCache = null;
    },

    invalidateCache: (): void => { sharedCache = null; templateImageCache.clear(); },
};
