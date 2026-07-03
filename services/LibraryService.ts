import { db, storage } from '../firebase';
import { SignTemplate } from '../types';
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

export const ADMIN_EMAIL = 'shansignimage1@gmail.com';
export const isLibraryAdmin = (email?: string | null): boolean =>
    !!email && email.toLowerCase() === ADMIN_EMAIL;

const SHARED_COLLECTION = 'library';
const PERSONAL_COLLECTION = 'userLibrary';

export interface NewTemplateInput {
    name: string;
    category: string;
    widthMm: number;
    heightMm: number;
    dataUri: string;
}

let sharedCache: SignTemplate[] | null = null;

const docToTemplate = (id: string, d: any, source: 'shared' | 'personal'): SignTemplate => ({
    id: `${source}_${id}`,
    docId: id,
    name: d.name ?? 'Untitled',
    category: d.category ?? 'Fascia',
    image: d.imageUrl ?? '',
    width: d.widthMm ?? 2000,
    height: d.heightMm ?? 500,
    source,
    storagePath: d.storagePath,
    ownerUid: d.ownerUid,
});

const uploadLibraryImage = async (storagePath: string, dataUri: string): Promise<string> => {
    const ref = storage.ref(storagePath);
    try {
        return await ref.getDownloadURL(); // content-addressed: may already exist
    } catch {
        await ref.put(dataUriToBlob(dataUri));
        return await ref.getDownloadURL();
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

export const LibraryService = {

    listShared: async (): Promise<SignTemplate[]> => {
        if (sharedCache) return sharedCache;
        const snapshot = await db.collection(SHARED_COLLECTION).limit(200).get();
        sharedCache = snapshot.docs
            .map(doc => docToTemplate(doc.id, doc.data(), 'shared'))
            .sort((a, b) => a.name.localeCompare(b.name));
        return sharedCache;
    },

    listPersonal: async (uid: string): Promise<SignTemplate[]> => {
        if (uid.startsWith('guest_')) return [];
        // No orderBy — avoids needing a composite index; sort client-side
        const snapshot = await db.collection(PERSONAL_COLLECTION)
            .where('ownerUid', '==', uid)
            .limit(200)
            .get();
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
        };
        await db.collection(PERSONAL_COLLECTION).doc(docId).set(data);
        return docToTemplate(docId, data, 'personal');
    },

    deletePersonal: async (template: SignTemplate): Promise<void> => {
        if (!template.docId) return;
        await db.collection(PERSONAL_COLLECTION).doc(template.docId).delete();
        if (template.storagePath) {
            await storage.ref(template.storagePath).delete()
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
        };
        const docRef = await db.collection(SHARED_COLLECTION).add(data);
        sharedCache = null; // refetch next time
        return docToTemplate(docRef.id, data, 'shared');
    },

    deleteShared: async (template: SignTemplate): Promise<void> => {
        if (!template.docId) return;
        await db.collection(SHARED_COLLECTION).doc(template.docId).delete();
        if (template.storagePath) {
            await storage.ref(template.storagePath).delete()
                .catch(e => console.warn('Library image delete skipped:', e));
        }
        sharedCache = null;
    },

    invalidateCache: (): void => { sharedCache = null; },
};
