import { DROPBOX_REF_PREFIX } from '../../types';
import { dataUriToBlob } from '../imageHash';
import { DriveAuthError, type DriveConnector } from './types';

const TOKEN_KEY = 'sp_dropbox_token';
const CONNECTED_KEY = 'sp_dropbox_connected';
const VERIFIER_KEY = 'sp_dropbox_verifier';
const STATE_KEY = 'sp_dropbox_state';
const EXPIRY_MARGIN = 60_000;
const appKey = () => import.meta.env.VITE_DROPBOX_APP_KEY;
type Token = { accessToken: string; expiresAt: number };

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (size = 64) => { const b = new Uint8Array(size); crypto.getRandomValues(b); return base64Url(b); };
const challenge = async (verifier: string) => base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
const redirectUri = () => `${window.location.origin}${window.location.pathname}`;

const readToken = (): Token | null => {
  try { return JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null'); } catch { return null; }
};
const validToken = () => { const value = readToken(); return value && value.expiresAt - EXPIRY_MARGIN > Date.now() ? value.accessToken : null; };

const completeRedirect = async (): Promise<boolean> => {
  const query = new URLSearchParams(window.location.search);
  const code = query.get('code');
  const state = query.get('state');
  if (!code || state !== sessionStorage.getItem(STATE_KEY) || !appKey()) return false;
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) return false;
  const body = new URLSearchParams({ code, grant_type: 'authorization_code', client_id: appKey()!, redirect_uri: redirectUri(), code_verifier: verifier });
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!response.ok) throw new Error(`Dropbox authorization failed: ${await response.text()}`);
  const result = await response.json();
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 }));
  localStorage.setItem(CONNECTED_KEY, '1');
  sessionStorage.removeItem(VERIFIER_KEY); sessionStorage.removeItem(STATE_KEY);
  history.replaceState({}, document.title, redirectUri());
  return true;
};

const api = async (url: string, init?: RequestInit) => {
  await completeRedirect().catch(() => false);
  const token = validToken();
  if (!token) throw new DriveAuthError('Dropbox session expired');
  const response = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (response.status === 401) { sessionStorage.removeItem(TOKEN_KEY); throw new DriveAuthError('Dropbox session expired'); }
  if (!response.ok) throw new Error(`Dropbox API ${response.status}: ${await response.text()}`);
  return response;
};
const refPath = (ref: string) => ref.slice(DROPBOX_REF_PREFIX.length);
const safeName = (name: string) => name.replace(/[\\/]/g, '_');
const upload = async (blob: Blob, name: string) => {
  const path = `/${safeName(name)}`;
  const response = await api('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', autorename: false }) }, body: blob,
  });
  const metadata = await response.json();
  return `${DROPBOX_REF_PREFIX}${metadata.id ?? path}`;
};

// Complete a full-page OAuth return as soon as the app reloads.
void completeRedirect().catch(error => console.warn('Dropbox OAuth return failed:', error));

export const dropboxConnector: DriveConnector = {
  id: 'dropbox', label: 'Dropbox', available: !!appKey(),
  isConnected: () => localStorage.getItem(CONNECTED_KEY) === '1' && !!validToken(),
  connect: async () => {
    if (!appKey()) throw new Error('Dropbox is not configured (missing app key).');
    const verifier = random(); const state = random(24);
    sessionStorage.setItem(VERIFIER_KEY, verifier); sessionStorage.setItem(STATE_KEY, state);
    const url = new URL('https://www.dropbox.com/oauth2/authorize');
    url.search = new URLSearchParams({ client_id: appKey()!, response_type: 'code', redirect_uri: redirectUri(), code_challenge: await challenge(verifier), code_challenge_method: 'S256', state, token_access_type: 'online', scope: 'files.content.read files.content.write' }).toString();
    window.location.assign(url.toString());
    await new Promise(() => undefined);
  },
  disconnect: async () => {
    if (validToken()) await api('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST' }).catch(() => undefined);
    sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(CONNECTED_KEY);
  },
  ensureReady: async interactive => {
    if (await completeRedirect().catch(() => false)) return true;
    if (validToken()) return true;
    if (interactive) await dropboxConnector.connect();
    return false;
  },
  uploadImage: (uri, hash) => upload(dataUriToBlob(uri), `image-${hash}`),
  uploadFile: upload,
  fetchImage: async ref => (await api('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': JSON.stringify({ path: refPath(ref) }) } })).blob(),
  deleteImage: async ref => { await api('https://api.dropboxapi.com/2/files/delete_v2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: refPath(ref) }) }).catch(() => undefined); },
  deleteAllAppData: async () => {
    let response = await api('https://api.dropboxapi.com/2/files/list_folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '', recursive: false }) });
    let data = await response.json(); const paths: string[] = [];
    paths.push(...(data.entries ?? []).map((entry: { path_lower: string }) => entry.path_lower));
    while (data.has_more) {
      response = await api('https://api.dropboxapi.com/2/files/list_folder/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cursor: data.cursor }) });
      data = await response.json(); paths.push(...(data.entries ?? []).map((entry: { path_lower: string }) => entry.path_lower));
    }
    await Promise.all(paths.map(path => api('https://api.dropboxapi.com/2/files/delete_v2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })));
  },
};
