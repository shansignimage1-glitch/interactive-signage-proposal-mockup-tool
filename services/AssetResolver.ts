import { MockupState, GDRIVE_REF_PREFIX } from '../types';
import { getActiveConnector, DriveAuthError } from './driveConnectors';
import { getCachedAsset, putCachedAsset } from './StorageService';
import { hashDataUri, blobToDataUri } from './imageHash';

// Materializes drive refs ("gdrive://<fileId>") stored in project JSON back
// into displayable data URIs at load time, and remembers the reverse mapping
// so the next autosave writes the SAME ref back without re-uploading.
//
// Resolution order: IndexedDB asset cache (works offline) → connector fetch
// (then cached). On failure the raw ref stays in state: it renders as a
// broken image but survives the next save untouched (the save path only
// re-uploads `data:` strings), so nothing is lost while disconnected.

export const isDriveRef = (s: string | null | undefined): s is string =>
    !!s && s.startsWith(GDRIVE_REF_PREFIX);

// dataUri-hash → ref, session-lifetime. Guarantees save-after-load is a no-op
// even if re-encoding isn't byte-identical to the originally uploaded file.
const knownRefs = new Map<string, string>();

export const recordKnownRef = (dataUriHash: string, ref: string): void => {
    knownRefs.set(dataUriHash, ref);
};

export const getKnownRef = (dataUriHash: string): string | undefined =>
    knownRefs.get(dataUriHash);

export const resolveRef = async (ref: string): Promise<string> => {
    const cached = await getCachedAsset(ref).catch(() => null);
    let blob = cached?.blob ?? null;

    if (!blob) {
        const connector = getActiveConnector();
        if (!connector) throw new DriveAuthError('No cloud drive connected');
        if (!(await connector.ensureReady(false))) throw new DriveAuthError();
        blob = await connector.fetchImage(ref);
        await putCachedAsset(ref, blob).catch(() => { /* cache is best-effort */ });
    }

    const dataUri = await blobToDataUri(blob);
    recordKnownRef(await hashDataUri(dataUri), ref);
    return dataUri;
};

export interface ResolveResult {
    state: MockupState;
    failedRefs: string[];
    needsReconnect: boolean;
}

export const resolveProjectImages = async (state: MockupState): Promise<ResolveResult> => {
    const failedRefs: string[] = [];
    let needsReconnect = false;

    // Same ref appearing in several places resolves once
    const perLoad = new Map<string, Promise<string>>();
    const resolveField = (value: string | null | undefined): Promise<string | null | undefined> => {
        if (!isDriveRef(value)) return Promise.resolve(value);
        if (!perLoad.has(value)) {
            perLoad.set(value, resolveRef(value).catch(e => {
                failedRefs.push(value);
                if (e instanceof DriveAuthError) needsReconnect = true;
                return value; // keep the raw ref in state
            }));
        }
        return perLoad.get(value)!;
    };

    const canvases = await Promise.all(state.canvases.map(async canvas => ({
        ...canvas,
        backgroundImage: (await resolveField(canvas.backgroundImage)) as string,
        signs: await Promise.all(canvas.signs.map(async sign => ({
            ...sign,
            image: (await resolveField(sign.image)) as string,
        }))),
    })));

    const logoImage = (await resolveField(state.titleBlock.logoImage)) ?? null;

    const referenceImages = await Promise.all((state.referenceImages ?? []).map(async r => ({
        ...r,
        image: (await resolveField(r.image)) as string,
    })));

    return {
        state: {
            ...state,
            canvases,
            titleBlock: { ...state.titleBlock, logoImage },
            referenceImages,
        },
        failedRefs,
        needsReconnect,
    };
};
