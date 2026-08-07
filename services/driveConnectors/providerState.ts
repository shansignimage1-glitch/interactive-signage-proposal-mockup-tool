import { CloudProvider, DROPBOX_REF_PREFIX, GDRIVE_REF_PREFIX, ONEDRIVE_REF_PREFIX } from '../../types';

const PREFERRED_KEY = 'sp_preferred_cloud_provider';

export const getPreferredProvider = (): CloudProvider =>
    (localStorage.getItem(PREFERRED_KEY) as CloudProvider | null) ?? 'google_drive';

export const setPreferredProvider = (provider: CloudProvider): void =>
    localStorage.setItem(PREFERRED_KEY, provider);

export const getProviderForRef = (ref: string): CloudProvider | null =>
    ref.startsWith(GDRIVE_REF_PREFIX) ? 'google_drive'
        : ref.startsWith(ONEDRIVE_REF_PREFIX) ? 'onedrive'
        : ref.startsWith(DROPBOX_REF_PREFIX) ? 'dropbox'
        : null;

export const isCloudDriveRef = (ref: string): boolean => getProviderForRef(ref) !== null;
