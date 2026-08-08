import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const monitoringMocks = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('../../services/monitoring', () => ({ reportError: monitoringMocks.reportError }));

import {
  CHUNK_RELOAD_COOLDOWN_MS,
  CHUNK_RELOAD_KEY,
  CHUNK_STABLE_WINDOW_MS,
  installChunkRecovery,
} from '../../services/chunkRecovery';

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
};

describe('stale lazy-chunk recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it('reloads once and suppresses the stale import error', () => {
    const target = new EventTarget();
    const storage = createStorage();
    const reload = vi.fn();
    const cleanup = installChunkRecovery({ target, storage, reload, now: () => 10_000 });
    const event = new Event('vite:preloadError', { cancelable: true });
    Object.assign(event, { payload: new Error('old chunk missing') });

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBe('10000');
    expect(monitoringMocks.reportError).toHaveBeenCalledWith(
      'stale-chunk',
      expect.any(Error),
      { automaticReload: true },
    );
    cleanup();
  });

  it('prevents reload loops and clears the guard after a stable load', () => {
    const target = new EventTarget();
    const storage = createStorage();
    storage.setItem(CHUNK_RELOAD_KEY, String(20_000));
    const reload = vi.fn();
    let now = 20_000 + CHUNK_RELOAD_COOLDOWN_MS - 1;
    const cleanup = installChunkRecovery({ target, storage, reload, now: () => now });
    const repeatedFailure = new Event('vite:preloadError', { cancelable: true });

    target.dispatchEvent(repeatedFailure);

    expect(repeatedFailure.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(monitoringMocks.reportError).toHaveBeenCalledWith(
      'stale-chunk',
      expect.any(Error),
      { automaticReloadSuppressed: true },
    );

    vi.advanceTimersByTime(CHUNK_STABLE_WINDOW_MS);
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBeNull();

    now += CHUNK_RELOAD_COOLDOWN_MS;
    const laterFailure = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(laterFailure);
    expect(laterFailure.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    cleanup();
  });
});
