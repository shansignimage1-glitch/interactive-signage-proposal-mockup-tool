import { CloudProvider } from '../../types';

// A user-owned cloud drive that can hold this app's project images. Google
// Drive is implemented; OneDrive/Dropbox are stubs (available: false) until
// their developer-app registrations exist. All implementations must be safe
// to call in environments where their SDK script didn't load.
export interface DriveConnector {
  id: CloudProvider;
  label: string;
  /** false = shown as "coming soon" in the UI, never used for storage */
  available: boolean;

  isConnected(): boolean;

  /** Interactive consent. MUST be called from a user gesture (click/tap) so
   *  the OAuth popup isn't blocked — especially on iPad Safari. */
  connect(): Promise<void>;

  disconnect(): Promise<void>;

  /** Ensure a usable access token. interactive=false tries cache + silent
   *  refresh only and resolves false when a user gesture is needed — callers
   *  on the autosave path must treat false as "fall back", never as an error. */
  ensureReady(interactive: boolean): Promise<boolean>;

  /** Upload (or dedupe against) an image; returns an opaque ref like
   *  "gdrive://<fileId>" that is persisted in project JSON. */
  uploadImage(dataUri: string, hash: string): Promise<string>;

  /** Fetch the binary for a ref produced by uploadImage. */
  fetchImage(ref: string): Promise<Blob>;

  /** Best-effort delete (trash) of a ref's file. Must not throw. */
  deleteImage(ref: string): Promise<void>;
}

/** Auth-shaped failure (expired/revoked token): the UI offers "reconnect"
 *  instead of treating the image as gone. */
export class DriveAuthError extends Error {
  constructor(message = 'Cloud drive session expired') {
    super(message);
    this.name = 'DriveAuthError';
  }
}
