/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

interface ImportMetaEnv {
  // OAuth web client ID from the sunny-ship-437805-c5 GCP project — used by
  // the Google Identity Services token client for Drive access. The Drive
  // connector shows "not configured" when this is absent.
  readonly VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
  readonly VITE_MICROSOFT_CLIENT_ID?: string;
  readonly VITE_DROPBOX_APP_KEY?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Minimal typings for the Google Identity Services script loaded in
// index.html (https://accounts.google.com/gsi/client). Only the token-client
// surface this app uses is declared.
declare namespace google.accounts.oauth2 {
  interface TokenResponse {
    access_token: string;
    expires_in: number; // seconds
    scope: string;
    token_type: string;
    error?: string;
    error_description?: string;
  }

  interface TokenClientConfig {
    client_id: string;
    scope: string;
    prompt?: '' | 'consent' | 'select_account';
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type: string; message?: string }) => void;
  }

  interface OverridableTokenClientConfig {
    prompt?: '' | 'consent' | 'select_account';
  }

  interface TokenClient {
    requestAccessToken(overrideConfig?: OverridableTokenClientConfig): void;
  }

  function initTokenClient(config: TokenClientConfig): TokenClient;
  function revoke(accessToken: string, done?: () => void): void;
}
