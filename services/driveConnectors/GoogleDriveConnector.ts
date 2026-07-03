import { GDRIVE_REF_PREFIX } from '../../types';
import { dataUriToBlob } from '../imageHash';
import { DriveConnector, DriveAuthError } from './types';

// Google Drive connector built on the Google Identity Services (GIS) token
// client + Drive REST v3 via fetch. The `drive.file` scope only grants access
// to files this app created — non-sensitive, no OAuth verification review.
//
// iPad/Safari notes: the GIS consent popup is allowed when triggered by a tap
// (connect() must run inside a click handler). Silent refresh (prompt:'') can
// be blocked by ITP; ensureReady(false) then resolves false and callers fall
// back to Firebase Storage — saving never depends on Drive being reachable.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'SignagePro';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

const TOKEN_KEY = 'sp_gdrive_token';
const CONNECTED_KEY = 'sp_gdrive_connected';
const FOLDER_KEY = 'sp_gdrive_folder';
const fileMapKey = (uid: string) => `sp_gdrive_filemap_${uid}`;

const SILENT_TIMEOUT_MS = 8000;
// Refuse tokens about to expire so an upload doesn't die mid-flight
const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken { accessToken: string; expiresAt: number }

let currentUid: string | null = null;
let memToken: CachedToken | null = null;
let tokenClient: google.accounts.oauth2.TokenClient | null = null;
// GIS delivers tokens through a static callback; each request swaps in its own resolver
let pendingResolver: ((r: google.accounts.oauth2.TokenResponse | Error) => void) | null = null;

const clientId = (): string | undefined =>
    (import.meta as any).env?.VITE_GOOGLE_OAUTH_CLIENT_ID;

const gisAvailable = (): boolean =>
    typeof google !== 'undefined' && !!google.accounts?.oauth2 && !!clientId();

const readStoredToken = (): CachedToken | null => {
    if (memToken) return memToken;
    try {
        const raw = sessionStorage.getItem(TOKEN_KEY);
        if (raw) memToken = JSON.parse(raw);
    } catch { /* ignore corrupt cache */ }
    return memToken;
};

const storeToken = (t: CachedToken | null) => {
    memToken = t;
    try {
        if (t) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t));
        else sessionStorage.removeItem(TOKEN_KEY);
    } catch { /* storage full/blocked — memory copy still works */ }
};

const validToken = (): string | null => {
    const t = readStoredToken();
    return t && t.expiresAt - EXPIRY_MARGIN_MS > Date.now() ? t.accessToken : null;
};

const getTokenClient = (): google.accounts.oauth2.TokenClient => {
    if (!tokenClient) {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId()!,
            scope: SCOPE,
            callback: (response) => pendingResolver?.(response),
            error_callback: (err) => pendingResolver?.(new Error(err.message ?? err.type)),
        });
    }
    return tokenClient;
};

// Runs one token request (silent or interactive). GIS has no cancel API, so a
// timeout guards the silent path against hanging forever under ITP.
const requestToken = (interactive: boolean): Promise<boolean> =>
    new Promise((resolve) => {
        if (!gisAvailable()) return resolve(false);
        let settled = false;
        const settle = (ok: boolean) => {
            if (settled) return;
            settled = true;
            pendingResolver = null;
            resolve(ok);
        };
        const timer = interactive ? null : setTimeout(() => settle(false), SILENT_TIMEOUT_MS);

        pendingResolver = (result) => {
            if (timer) clearTimeout(timer);
            if (result instanceof Error || result.error || !result.access_token) return settle(false);
            storeToken({
                accessToken: result.access_token,
                expiresAt: Date.now() + result.expires_in * 1000,
            });
            settle(true);
        };
        try {
            getTokenClient().requestAccessToken(interactive ? {} : { prompt: '' });
        } catch {
            settle(false);
        }
    });

// --- Drive REST helpers ---

const driveFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const token = validToken();
    if (!token) throw new DriveAuthError();
    const res = await fetch(url, {
        ...init,
        headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
        storeToken(null); // force a refresh next time
        throw new DriveAuthError();
    }
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text().catch(() => '')}`);
    return res;
};

const findOrCreateFolder = async (): Promise<string> => {
    const cached = localStorage.getItem(FOLDER_KEY);
    if (cached) {
        // Re-verify: the user may have deleted the folder from Drive directly
        try {
            const res = await driveFetch(`${API}/files/${cached}?fields=id,trashed`);
            const meta = await res.json();
            if (!meta.trashed) return cached;
        } catch (e) {
            if (e instanceof DriveAuthError) throw e;
            // 404 etc — fall through and recreate
        }
        localStorage.removeItem(FOLDER_KEY);
    }

    const q = encodeURIComponent(
        `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`
    );
    const found = await (await driveFetch(`${API}/files?q=${q}&fields=files(id)`)).json();
    let id: string | undefined = found.files?.[0]?.id;

    if (!id) {
        const created = await (await driveFetch(`${API}/files?fields=id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
        })).json();
        id = created.id;
    }
    if (!id) throw new Error('Could not create SignagePro folder in Drive');
    localStorage.setItem(FOLDER_KEY, id);
    return id;
};

// hash → fileId map so repeated autosaves of the same image never re-upload.
// localStorage survives reloads; the Drive appProperties query below is the
// source of truth if this cache is lost.
const readFileMap = (): Record<string, string> => {
    if (!currentUid) return {};
    try { return JSON.parse(localStorage.getItem(fileMapKey(currentUid)) ?? '{}'); }
    catch { return {}; }
};

const writeFileMap = (map: Record<string, string>) => {
    if (!currentUid) return;
    try { localStorage.setItem(fileMapKey(currentUid), JSON.stringify(map)); }
    catch { /* best-effort cache */ }
};

const refToFileId = (ref: string): string => ref.slice(GDRIVE_REF_PREFIX.length);

// --- Connector ---

export const googleDriveConnector: DriveConnector = {
    id: 'google_drive',
    label: 'Google Drive',
    available: true,

    isConnected: () => localStorage.getItem(CONNECTED_KEY) === '1' && !!validToken(),

    connect: async () => {
        if (!clientId()) {
            throw new Error('Google Drive is not configured yet (missing OAuth client ID). Ask the app owner to finish setup.');
        }
        if (typeof google === 'undefined' || !google.accounts?.oauth2) {
            throw new Error('Google sign-in script could not load. Check your network and try again.');
        }
        const ok = await requestToken(true);
        if (!ok) throw new Error('Google Drive connection was cancelled or failed.');
        localStorage.setItem(CONNECTED_KEY, '1');
        // Materialize the folder now so the first autosave doesn't pay for it
        await findOrCreateFolder().catch(() => { /* created lazily on first upload */ });
    },

    disconnect: async () => {
        const t = readStoredToken();
        if (t && typeof google !== 'undefined' && google.accounts?.oauth2) {
            try { google.accounts.oauth2.revoke(t.accessToken); } catch { /* already invalid */ }
        }
        storeToken(null);
        localStorage.removeItem(CONNECTED_KEY);
        localStorage.removeItem(FOLDER_KEY);
    },

    ensureReady: async (interactive) => {
        if (localStorage.getItem(CONNECTED_KEY) !== '1') return false;
        if (validToken()) return true;
        if (!gisAvailable()) return false;
        if (await requestToken(false)) return true;
        return interactive ? requestToken(true) : false;
    },

    uploadImage: async (dataUri, hash) => {
        const map = readFileMap();
        if (map[hash]) return `${GDRIVE_REF_PREFIX}${map[hash]}`;

        // Cache miss — the file may still exist in Drive (cleared localStorage,
        // other device): appProperties carries the content hash.
        const q = encodeURIComponent(`appProperties has { key='sha256' and value='${hash}' } and trashed=false`);
        const found = await (await driveFetch(`${API}/files?q=${q}&fields=files(id)`)).json();
        let fileId: string | undefined = found.files?.[0]?.id;

        if (!fileId) {
            const folderId = await findOrCreateFolder();
            const blob = dataUriToBlob(dataUri);
            const ext = blob.type.split('/')[1]?.split('+')[0] ?? 'png';
            const metadata = {
                name: `${hash.slice(0, 16)}.${ext}`,
                parents: [folderId],
                appProperties: { sha256: hash },
            };
            const body = new FormData();
            body.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            body.append('file', blob);
            const created = await (await driveFetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
                method: 'POST',
                body,
            })).json();
            fileId = created.id;
        }
        if (!fileId) throw new Error('Drive upload did not return a file id');
        map[hash] = fileId;
        writeFileMap(map);
        return `${GDRIVE_REF_PREFIX}${fileId}`;
    },

    fetchImage: async (ref) => {
        const res = await driveFetch(`${API}/files/${refToFileId(ref)}?alt=media`);
        return res.blob();
    },

    deleteImage: async (ref) => {
        try {
            await driveFetch(`${API}/files/${refToFileId(ref)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trashed: true }),
            });
        } catch (e) {
            console.warn('Could not trash Drive file (skipping):', e);
        }
    },
};

export const setGoogleDriveUid = (uid: string | null) => { currentUid = uid; };
