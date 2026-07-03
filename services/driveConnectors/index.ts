import { CloudProvider } from '../../types';
import { DriveConnector } from './types';
import { googleDriveConnector, setGoogleDriveUid } from './GoogleDriveConnector';

export type { DriveConnector } from './types';
export { DriveAuthError } from './types';

// Placeholder connectors shown as "coming soon" — each needs its own
// developer-app registration (Azure portal / Dropbox console) before it can
// be implemented behind this same interface.
const stub = (id: CloudProvider, label: string): DriveConnector => ({
    id,
    label,
    available: false,
    isConnected: () => false,
    connect: async () => { throw new Error(`${label} support is coming soon.`); },
    disconnect: async () => {},
    ensureReady: async () => false,
    uploadImage: async () => { throw new Error(`${label} support is coming soon.`); },
    fetchImage: async () => { throw new Error(`${label} support is coming soon.`); },
    deleteImage: async () => {},
});

export const connectors: DriveConnector[] = [
    googleDriveConnector,
    stub('onedrive', 'OneDrive'),
    stub('dropbox', 'Dropbox'),
];

/** The connector currently holding the user's images, or null when none is
 *  connected (Firebase Storage fallback applies). */
export const getActiveConnector = (): DriveConnector | null =>
    connectors.find(c => c.available && c.isConnected()) ?? null;

/** Scope per-user caches (e.g. the Drive hash→fileId map) to the signed-in uid. */
export const setConnectorUid = (uid: string | null) => {
    setGoogleDriveUid(uid);
};
