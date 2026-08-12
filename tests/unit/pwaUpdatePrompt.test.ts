import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pwaMocks = vi.hoisted(() => ({
  useRegisterSW: vi.fn(),
  setNeedRefresh: vi.fn(),
  updateServiceWorker: vi.fn(),
}));
const monitoringMocks = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: pwaMocks.useRegisterSW,
}));
vi.mock('../../services/monitoring', () => ({
  reportError: monitoringMocks.reportError,
}));

import PwaUpdatePrompt from '../../components/PwaUpdatePrompt';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const findButton = (label: string): HTMLButtonElement => {
  const button = Array.from(document.querySelectorAll('button'))
    .find(candidate => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
};

describe('PwaUpdatePrompt', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    pwaMocks.updateServiceWorker.mockResolvedValue(undefined);
    pwaMocks.useRegisterSW.mockReturnValue({
      needRefresh: [false, pwaMocks.setNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: pwaMocks.updateServiceWorker,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('stays hidden when the current app shell is up to date', async () => {
    await act(async () => root.render(React.createElement(PwaUpdatePrompt)));
    expect(document.body.textContent).not.toContain('New SignagePro version');
  });

  it('offers an explicit update without silently discarding open work', async () => {
    pwaMocks.useRegisterSW.mockReturnValue({
      needRefresh: [true, pwaMocks.setNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: pwaMocks.updateServiceWorker,
    });

    await act(async () => root.render(React.createElement(PwaUpdatePrompt)));

    expect(document.body.textContent).toContain('New SignagePro version');
    await act(async () => findButton('Update now').click());
    expect(pwaMocks.updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it('lets the user postpone a reload while editing', async () => {
    pwaMocks.useRegisterSW.mockReturnValue({
      needRefresh: [true, pwaMocks.setNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: pwaMocks.updateServiceWorker,
    });

    await act(async () => root.render(React.createElement(PwaUpdatePrompt)));
    await act(async () => findButton('Later').click());

    expect(pwaMocks.setNeedRefresh).toHaveBeenCalledWith(false);
    expect(pwaMocks.updateServiceWorker).not.toHaveBeenCalled();
  });

  it('does not block editor controls behind the offline-ready notice', async () => {
    const setOfflineReady = vi.fn();
    pwaMocks.useRegisterSW.mockReturnValue({
      needRefresh: [false, pwaMocks.setNeedRefresh],
      offlineReady: [true, setOfflineReady],
      updateServiceWorker: pwaMocks.updateServiceWorker,
    });

    await act(async () => root.render(React.createElement(PwaUpdatePrompt)));

    const notice = document.querySelector('aside');
    expect(notice?.className).toContain('pointer-events-none');
    expect(findButton('Dismiss').className).toContain('pointer-events-auto');

    await act(async () => findButton('Dismiss').click());
    expect(setOfflineReady).toHaveBeenCalledWith(false);
  });
});
