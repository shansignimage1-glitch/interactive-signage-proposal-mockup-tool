import { PublicClientApplication, InteractionRequiredAuthError, type AccountInfo } from '@azure/msal-browser';
import { ONEDRIVE_REF_PREFIX } from '../../types';
import { dataUriToBlob } from '../imageHash';
import { DriveAuthError, type DriveConnector } from './types';

const SCOPES = ['Files.ReadWrite.AppFolder', 'User.Read'];
const CONNECTED_KEY = 'sp_onedrive_connected';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const clientId = () => import.meta.env.VITE_MICROSOFT_CLIENT_ID;
let app: PublicClientApplication | null = null;
let initialized: Promise<void> | null = null;
let account: AccountInfo | null = null;

const getApp = async () => {
  if (!clientId()) throw new Error('OneDrive is not configured (missing Microsoft client ID).');
  if (!app) {
    app = new PublicClientApplication({
      auth: { clientId: clientId()!, authority: 'https://login.microsoftonline.com/common', redirectUri: window.location.origin },
      cache: { cacheLocation: 'localStorage' },
    });
    initialized = app.initialize().then(async () => {
      const result = await app!.handleRedirectPromise();
      account = result?.account ?? app!.getAllAccounts()[0] ?? null;
      if (account) app!.setActiveAccount(account);
    });
  }
  await initialized;
  return app;
};

const token = async (interactive: boolean): Promise<string | null> => {
  const pca = await getApp();
  account = pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
  if (!account) return null;
  try {
    return (await pca.acquireTokenSilent({ account, scopes: SCOPES })).accessToken;
  } catch (e) {
    if (!interactive || !(e instanceof InteractionRequiredAuthError)) return null;
    return (await pca.acquireTokenPopup({ account, scopes: SCOPES })).accessToken;
  }
};

const graph = async (path: string, init?: RequestInit) => {
  const accessToken = await token(false);
  if (!accessToken) throw new DriveAuthError('OneDrive session expired');
  const response = await fetch(path.startsWith('https://') ? path : `${GRAPH}${path}`, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${accessToken}` } });
  if (response.status === 401) throw new DriveAuthError('OneDrive session expired');
  if (!response.ok) throw new Error(`OneDrive API ${response.status}: ${await response.text()}`);
  return response;
};

const itemId = (ref: string) => ref.slice(ONEDRIVE_REF_PREFIX.length);
const safeName = (name: string) => name.replace(/["*:<>?\\|/]/g, '_');
const upload = async (blob: Blob, name: string) => {
  const response = await graph(`/me/drive/special/approot:/${encodeURIComponent(safeName(name))}:/content`, { method: 'PUT', body: blob });
  const metadata = await response.json();
  if (!metadata.id) throw new Error('OneDrive upload did not return a file id');
  return `${ONEDRIVE_REF_PREFIX}${metadata.id}`;
};

export const oneDriveConnector: DriveConnector = {
  id: 'onedrive', label: 'Microsoft OneDrive', available: !!clientId(),
  isConnected: () => localStorage.getItem(CONNECTED_KEY) === '1',
  connect: async () => {
    const pca = await getApp();
    const result = await pca.loginPopup({ scopes: SCOPES });
    account = result.account;
    pca.setActiveAccount(account);
    localStorage.setItem(CONNECTED_KEY, '1');
  },
  disconnect: async () => {
    const pca = await getApp();
    const active = pca.getActiveAccount() ?? pca.getAllAccounts()[0];
    if (active) await pca.logoutPopup({ account: active, postLogoutRedirectUri: window.location.origin });
    account = null;
    localStorage.removeItem(CONNECTED_KEY);
  },
  ensureReady: async interactive => !!(await token(interactive).catch(() => null)),
  uploadImage: async (uri, hash) => upload(dataUriToBlob(uri), `image-${hash}`),
  uploadFile: upload,
  fetchImage: async ref => (await graph(`/me/drive/items/${encodeURIComponent(itemId(ref))}/content`)).blob(),
  deleteImage: async ref => { await graph(`/me/drive/items/${encodeURIComponent(itemId(ref))}`, { method: 'DELETE' }).catch(() => undefined); },
  deleteAllAppData: async () => {
    let next: string | null = '/me/drive/special/approot/children?$select=id&$top=999';
    const ids: string[] = [];
    while (next) {
      const response = await graph(next); const data = await response.json();
      ids.push(...(data.value ?? []).map((item: { id: string }) => item.id));
      next = data['@odata.nextLink'] ?? null;
    }
    await Promise.all(ids.map(id => graph(`/me/drive/items/${encodeURIComponent(id)}`, { method: 'DELETE' })));
  },
};
