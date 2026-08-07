import { DriveConnector } from './types';
import { googleDriveConnector, setGoogleDriveUid } from './GoogleDriveConnector';
import { oneDriveConnector } from './OneDriveConnector';
import { dropboxConnector } from './DropboxConnector';

export type { DriveConnector } from './types';
export { DriveAuthError } from './types';
export { getPreferredProvider, setPreferredProvider } from './providerState';
import { getPreferredProvider, getProviderForRef } from './providerState';

export const connectors: DriveConnector[] = [
    googleDriveConnector,
    oneDriveConnector,
    dropboxConnector,
];

/** The connector currently holding the user's images, or null when none is
 *  connected (Firebase Storage fallback applies). */
export const getActiveConnector = (): DriveConnector | null =>
    connectors.find(c => c.id === getPreferredProvider() && c.available && c.isConnected()) ?? null;

export const getConnectorForRef = (ref: string): DriveConnector | null => {
    const id = getProviderForRef(ref);
    return id ? connectors.find(connector => connector.id === id) ?? null : null;
};

/** Scope per-user caches (e.g. the Drive hash→fileId map) to the signed-in uid. */
export const setConnectorUid = (uid: string | null) => {
    setGoogleDriveUid(uid);
};
