import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sign, UserProfile } from '../../types';

const libraryMocks = vi.hoisted(() => ({
  listShared: vi.fn(),
  listPersonal: vi.fn(),
  saveToPersonal: vi.fn(),
  saveToShared: vi.fn(),
  updateShared: vi.fn(),
  deletePersonal: vi.fn(),
  deleteShared: vi.fn(),
  materializeDataUri: vi.fn(),
  materializeTemplateDataUri: vi.fn(),
}));
const feedbackMocks = vi.hoisted(() => ({
  notify: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../../services/LibraryService', () => ({
  LibraryService: {
    listShared: libraryMocks.listShared,
    listPersonal: libraryMocks.listPersonal,
    saveToPersonal: libraryMocks.saveToPersonal,
    saveToShared: libraryMocks.saveToShared,
    updateShared: libraryMocks.updateShared,
    deletePersonal: libraryMocks.deletePersonal,
    deleteShared: libraryMocks.deleteShared,
  },
  isLibraryAdmin: (user?: { isAdmin?: boolean } | null) => user?.isAdmin === true,
  materializeDataUri: libraryMocks.materializeDataUri,
  materializeTemplateDataUri: libraryMocks.materializeTemplateDataUri,
}));
vi.mock('../../services/toast', () => ({ notify: feedbackMocks.notify }));
vi.mock('../../services/monitoring', () => ({ reportError: feedbackMocks.reportError }));

import SignLibrary from '../../components/SignLibrary';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user: UserProfile = {
  uid: 'user-123',
  displayName: 'Test User',
  email: 'test@example.com',
  photoURL: null,
};

const activeSign = {
  id: 'sign-1',
  name: 'Reception Letters',
  image: 'data:image/png;base64,dGVzdA==',
  signType: 'fascia_non_ill',
} as Sign;

const findButton = (label: string): HTMLButtonElement => {
  const button = Array.from(document.querySelectorAll('button'))
    .find(candidate => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
};

describe('SignLibrary save editor', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(async () => {
    vi.clearAllMocks();
    libraryMocks.listShared.mockResolvedValue([]);
    libraryMocks.listPersonal.mockResolvedValue([]);
    libraryMocks.materializeDataUri.mockResolvedValue(activeSign.image);
    libraryMocks.materializeTemplateDataUri.mockResolvedValue(activeSign.image);
    libraryMocks.saveToPersonal.mockResolvedValue({
      id: 'personal-user-123',
      docId: 'user-123_hash',
      source: 'personal',
      ownerUid: user.uid,
      name: activeSign.name,
      category: 'Fascia',
      image: 'https://example.com/sign.png',
      width: 2000,
      height: 500,
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(SignLibrary, {
        isOpen: true,
        onClose: vi.fn(),
        onSelect: vi.fn(),
        user,
        activeSign,
      }));
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const openSaveEditor = async (): Promise<HTMLElement> => {
    await act(async () => {
      findButton('Save Current Sign').click();
      await Promise.resolve();
    });
    const heading = Array.from(document.querySelectorAll('h3'))
      .find(candidate => candidate.textContent?.includes('Save to Library'));
    expect(heading).not.toBeUndefined();
    return heading!.parentElement!;
  };

  it('does not discard the editor when its backdrop is clicked', async () => {
    const dialog = await openSaveEditor();
    const backdrop = dialog.parentElement!;

    await act(async () => backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(document.body.contains(dialog)).toBe(true);
  });

  it('saves the image only when the explicit save action is used', async () => {
    const dialog = await openSaveEditor();

    await act(async () => {
      findButton('Save asset to My Library').click();
      await Promise.resolve();
    });

    expect(libraryMocks.saveToPersonal).toHaveBeenCalledOnce();
    expect(libraryMocks.saveToPersonal).toHaveBeenCalledWith(
      user.uid,
      expect.objectContaining({ name: activeSign.name, dataUri: activeSign.image }),
    );
    expect(document.body.contains(dialog)).toBe(false);
    expect(feedbackMocks.notify).toHaveBeenCalledWith('Asset saved to My Library.', 'success');
  });

  it('reveals a newly saved asset even when a catalog filter was active', async () => {
    const categoryFilter = document.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      categoryFilter.value = 'Window';
      categoryFilter.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await openSaveEditor();
    await act(async () => {
      findButton('Save asset to My Library').click();
      await Promise.resolve();
    });

    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('All');
    expect(document.querySelector('img[alt="Reception Letters"]')).not.toBeNull();
  });

  it('does not let an older cloud-list response erase a newly saved asset', async () => {
    let resolvePersonalLoad!: (templates: []) => void;
    const stalePersonalLoad = new Promise<[]>(resolve => { resolvePersonalLoad = resolve; });

    await act(async () => {
      root.render(React.createElement(SignLibrary, {
        isOpen: false,
        onClose: vi.fn(),
        onSelect: vi.fn(),
        user,
        activeSign,
      }));
    });
    libraryMocks.listPersonal.mockReturnValueOnce(stalePersonalLoad);
    await act(async () => {
      root.render(React.createElement(SignLibrary, {
        isOpen: true,
        onClose: vi.fn(),
        onSelect: vi.fn(),
        user,
        activeSign,
      }));
      await Promise.resolve();
    });

    await openSaveEditor();
    await act(async () => {
      findButton('Save asset to My Library').click();
      await Promise.resolve();
    });
    expect(document.querySelector('img[alt="Reception Letters"]')).not.toBeNull();

    await act(async () => {
      resolvePersonalLoad([]);
      await stalePersonalLoad;
      await Promise.resolve();
    });

    expect(document.querySelector('img[alt="Reception Letters"]')).not.toBeNull();
  });

  it('shows My Library even while Shared Library is still loading', async () => {
    const neverResolvingSharedLoad = new Promise<[]>(() => undefined);
    libraryMocks.listShared.mockReturnValueOnce(neverResolvingSharedLoad);
    libraryMocks.listPersonal.mockResolvedValueOnce([{
      id: 'personal-upload', source: 'personal', ownerUid: user.uid,
      name: 'Uploaded sign', category: 'Fascia', image: 'https://example.com/upload.png',
      storagePath: 'users/user-123/library/upload', width: 2000, height: 500,
    }]);

    await act(async () => {
      root.render(React.createElement(SignLibrary, {
        isOpen: false, onClose: vi.fn(), onSelect: vi.fn(), user, activeSign,
      }));
    });
    await act(async () => {
      root.render(React.createElement(SignLibrary, {
        isOpen: true, onClose: vi.fn(), onSelect: vi.fn(), user, activeSign,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => findButton('My Library').click());

    expect(document.querySelector('img[alt="Uploaded sign"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Loading Uploaded sign thumbnail"]')).toBeNull();
  });

  it('keeps the editor and its metadata visible when cloud save fails', async () => {
    libraryMocks.saveToPersonal.mockRejectedValueOnce(new Error('Storage permission denied'));
    const dialog = await openSaveEditor();

    await act(async () => {
      findButton('Save asset to My Library').click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(document.body.contains(dialog)).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Storage permission denied');
    expect(feedbackMocks.reportError).toHaveBeenCalledWith(
      'library-save',
      expect.any(Error),
      { source: 'personal' },
    );
  });
});
