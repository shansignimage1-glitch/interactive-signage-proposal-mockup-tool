import { reportError } from './monitoring';

export const CHUNK_RELOAD_KEY = 'signagepro_chunk_reload_at';
export const CHUNK_RELOAD_COOLDOWN_MS = 60_000;
export const CHUNK_STABLE_WINDOW_MS = 20_000;

interface ChunkRecoveryOptions {
  target?: EventTarget;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  reload?: () => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

const storedReloadAt = (storage: ChunkRecoveryOptions['storage']): number => {
  try {
    const value = Number(storage?.getItem(CHUNK_RELOAD_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};

/**
 * Recovers an already-open PWA after a deploy removes a hashed lazy chunk.
 * Vite emits `vite:preloadError`; one reload picks up the new app shell and
 * service worker. A session-scoped cooldown prevents a bad cache from looping.
 */
export const installChunkRecovery = (options: ChunkRecoveryOptions = {}): (() => void) => {
  const target = options.target ?? window;
  const storage = options.storage ?? window.sessionStorage;
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  let reloadingThisRuntime = false;

  const onPreloadError = (event: Event) => {
    const failedAt = now();
    const previousReloadAt = storedReloadAt(storage);
    const recentlyReloaded = previousReloadAt > 0 && failedAt - previousReloadAt < CHUNK_RELOAD_COOLDOWN_MS;
    const payload = (event as Event & { payload?: unknown }).payload ?? new Error('A lazy-loaded app file could not be loaded.');

    if (reloadingThisRuntime || recentlyReloaded) {
      reportError('stale-chunk', payload, { automaticReloadSuppressed: true });
      return;
    }

    event.preventDefault();
    reloadingThisRuntime = true;
    try {
      storage.setItem(CHUNK_RELOAD_KEY, String(failedAt));
    } catch {
      // Reload still gives the browser a chance to fetch the current app shell.
    }
    reportError('stale-chunk', payload, { automaticReload: true });
    reload();
  };

  target.addEventListener('vite:preloadError', onPreloadError);
  const stableTimer = schedule(() => {
    try {
      storage.removeItem(CHUNK_RELOAD_KEY);
    } catch {
      // Storage can be unavailable in hardened/private browser modes.
    }
  }, CHUNK_STABLE_WINDOW_MS);

  return () => {
    target.removeEventListener('vite:preloadError', onPreloadError);
    cancelSchedule(stableTimer);
  };
};
