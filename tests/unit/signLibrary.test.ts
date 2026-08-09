import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sign, UserProfile } from '../../types';

const libraryMocks = vi.hoisted(() => ({
  listShared: vi.fn(),
  listPersonal: vi.fn(),
  recoverPersonalUploads: vi.fn(),
  saveToPersonal: vi.fn(),
  saveToShared: vi.fn(),
  updateShared: vi.fn(),
  deletePersonal: vi.fn(),
  deleteShared: vi.fn(),
  materializeDataUri: vi.fn(),
  materializeTemplateDataUri: vi.fn(),
  refreshTemplateImageUrl: vi.fn(),
}));
const feedbackMocks = vi.hoisted(() => ({
  notify: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('../../services/LibraryService', () => ({
  LibraryService: {
    listShared: libraryMocks.listShared,
    listPersonal: libraryMocks.listPersonal,
    recoverPersonalUploads: libraryMocks.recoverPersonalUploads,
    saveToPersonal: libraryMocks.saveToPersonal,
    saveToShared: libraryMocks.saveToShared,
    updateShared: libraryMocks.updateShared,
    deletePersonal: libraryMocks.deletePersonal,
    deleteShared: libraryMocks.deleteShared,
  },
  isLibraryAdmin: (user?: { isAdmin?: boolean } | null) => user?.isAdmin === true,
  materializeDataUri: libraryMocks.materializeDataUri,
  materializeTemplateDataUri: libraryMocks.materializeTemplateDataUri,
  refreshTemplateImageUrl: libraryMocks.refreshTemplateImageUrl,
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
    libraryMocks.recoverPersonalUploads.mockResolvedValue([]);
    libraryMocks.materializeDataUri.mockResolvedValue(activeSign.image);
    libraryMocks.materializeTemplateDataUri.mockResolvedValue(activeSign.image);
    libraryMocks.refreshTemplateImageUrl.mockResolvedValue('https://example.com/refreshed.png');
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

  it('shows saved uploads without waiting for Storage recovery', async () => {
    const neverResolvingRecovery = new Promise<[]>(() => undefined);
    libraryMocks.listPersonal.mockResolvedValueOnce([{
      id: 'personal-upload', source: 'personal', ownerUid: user.uid,
      name: 'Saved upload', category: 'Fascia', image: 'https://example.com/upload.png',
      storagePath: 'users/user-123/library/upload', width: 2000, height: 500,
    }]);
    libraryMocks.recoverPersonalUploads.mockReturnValueOnce(neverResolvingRecovery);

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

    expect(document.querySelector('img[alt="Saved upload"]')).not.toBeNull();
  });

  it('keeps saved uploads visible and reports a background recovery failure', async () => {
    libraryMocks.listPersonal.mockResolvedValueOnce([{
      id: 'personal-upload', source: 'personal', ownerUid: user.uid,
      name: 'Saved upload', category: 'Fascia', image: 'https://example.com/upload.png',
      storagePath: 'users/user-123/library/upload', width: 2000, height: 500,
    }]);
    libraryMocks.recoverPersonalUploads.mockRejectedValueOnce(new Error('Checking uploaded signs timed out'));

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

    expect(document.querySelector('img[alt="Saved upload"]')).not.toBeNull();
    expect(document.body.textContent).toContain('My Library recovery: Checking uploaded signs timed out');
  });

  it('does not recover without Firestore metadata needed to suppress tombstones', async () => {
    await act(async () => {
      root.render(React.createElement(SignLibrary, {
        isOpen: false, onClose: vi.fn(), onSelect: vi.fn(), user, activeSign,
      }));
    });
    vi.clearAllMocks();
    libraryMocks.listShared.mockResolvedValue([]);
    libraryMocks.listPersonal.mockRejectedValueOnce(new Error('Firestore offline'));
    libraryMocks.recoverPersonalUploads.mockResolvedValue([]);

    await act(async () => {
      root.render(React.createElement(SignLibrary, {
        isOpen: true, onClose: vi.fn(), onSelect: vi.fn(), user, activeSign,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(libraryMocks.recoverPersonalUploads).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('My Library: Firestore offline');
  });

  it('hides deletion tombstones while using them to suppress Storage recovery', async () => {
    const tombstone = {
      id: 'personal-deleting', docId: 'user-123_hash', source: 'personal' as const, ownerUid: user.uid,
      name: 'Deleting upload', category: 'Fascia', image: 'https://example.com/deleting.png',
      storagePath: 'users/user-123/library/hash', width: 2000, height: 500, deleting: true,
    };
    libraryMocks.listPersonal.mockResolvedValueOnce([tombstone]);

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

    expect(document.querySelector('img[alt="Deleting upload"]')).toBeNull();
    expect(libraryMocks.recoverPersonalUploads).toHaveBeenCalledWith(user.uid, [tombstone]);
  });

  it('adds recovered Storage uploads without inventing dimensions', async () => {
    libraryMocks.listPersonal.mockResolvedValueOnce([]);
    libraryMocks.recoverPersonalUploads.mockResolvedValueOnce([{
      id: 'personal-recovered', source: 'personal', ownerUid: user.uid,
      name: 'Recovered upload 1', category: 'Recovered', image: 'https://example.com/recovered.png',
      storagePath: 'users/user-123/library/recovered', width: 1, height: 1, recovered: true,
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

    expect(document.querySelector('img[alt="Recovered upload 1"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Original proportions');
    expect(Array.from(document.querySelectorAll('option')).some(option => option.textContent === 'Recovered')).toBe(true);
  });

  it('refreshes a cloud thumbnail once when its persisted URL has expired', async () => {
    const uploaded = {
      id: 'personal-upload', source: 'personal' as const, ownerUid: user.uid,
      name: 'Uploaded sign', category: 'Fascia', image: 'https://example.com/expired.png',
      storagePath: 'users/user-123/library/upload', width: 2000, height: 500,
    };
    libraryMocks.listPersonal.mockResolvedValueOnce([uploaded]);

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
    });
    await act(async () => findButton('My Library').click());

    const expiredImage = document.querySelector('img[alt="Uploaded sign"]') as HTMLImageElement;
    await act(async () => {
      expiredImage.dispatchEvent(new Event('error'));
      await Promise.resolve();
    });

    expect(libraryMocks.refreshTemplateImageUrl).toHaveBeenCalledWith(uploaded);
    expect((document.querySelector('img[alt="Uploaded sign"]') as HTMLImageElement).src)
      .toBe('https://example.com/refreshed.png');
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
