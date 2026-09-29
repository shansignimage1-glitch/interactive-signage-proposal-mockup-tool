import { CloudProvider } from '../../types';
import { DriveConnector } from './types';
import { googleDriveConnector, setGoogleDriveUid } from './GoogleDriveConnector';
import { oneDriveConnector } from './OneDriveConnector';
import { dropboxConnector } from './DropboxConnector';

export type { DriveConnector } from './types';
export { DriveAuthError } from './types';
export { getPreferredProvider, setPreferredProvider } from './providerState';
import { getPreferredProvider, getProviderForRef } from './providerState';

// Provider sessions (tokens, "connected" flags) live in browser storage and
// outlive a Firebase sign-out. On a shared iPad that meant the next account
// silently uploaded its photos into the previous account's drive and saved
// refs its own devices could never open. Each connection is therefore owned by
// the Firebase uid that made it, and is invisible to any other account.
let currentUid: string | null = null;
const ownerKey = (provider: CloudProvider) => `sp_drive_owner_${provider}`;

const ownedByCurrentUser = (provider: CloudProvider): boolean => {
    if (!currentUid) return false;
    const owner = localStorage.getItem(ownerKey(provider));
    if (!owner) {
        // A connection made before ownership was recorded (or completed via a
        // full-page OAuth redirect) is claimed by the first account to use it.
        localStorage.setItem(ownerKey(provider), currentUid);
        return true;
    }
    return owner === currentUid;
};

const withAccountOwnership = (connector: DriveConnector): DriveConnector => ({
    ...connector,
    isConnected: () => connector.isConnected() && ownedByCurrentUser(connector.id),
    connect: async () => {
        // Record ownership BEFORE connecting: redirect-based providers
        // (OneDrive, Dropbox) leave the page and never resume this call.
        if (currentUid) localStorage.setItem(ownerKey(connector.id), currentUid);
        await connector.connect();
    },
    disconnect: async () => {
        await connector.disconnect();
        localStorage.removeItem(ownerKey(connector.id));
    },
    ensureReady: async interactive =>
        ownedByCurrentUser(connector.id) ? connector.ensureReady(interactive) : false,
});

export const connectors: DriveConnector[] = [
    googleDriveConnector,
    oneDriveConnector,
    dropboxConnector,
].map(withAccountOwnership);

/** The connector currently holding the user's images, or null when none is
 *  connected (Firebase Storage fallback applies). */
export const getActiveConnector = (): DriveConnector | null =>
    connectors.find(c => c.id === getPreferredProvider() && c.available && c.isConnected()) ?? null;

export const getConnectorForRef = (ref: string): DriveConnector | null => {
    const id = getProviderForRef(ref);
    return id ? connectors.find(connector => connector.id === id) ?? null : null;
};

/** Scope per-user caches (e.g. the Drive hash→fileId map) and provider
 *  ownership to the signed-in uid. Pass null on sign-out. */
export const setConnectorUid = (uid: string | null) => {
    currentUid = uid;
    setGoogleDriveUid(uid);
};
