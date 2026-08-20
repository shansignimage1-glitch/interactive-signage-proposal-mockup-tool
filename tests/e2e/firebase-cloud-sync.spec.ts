import { devices, expect, test } from '@playwright/test';

const EMAIL = 'xplore-iphone-e2e@example.test';
const PASSWORD = 'xplore-iphone-e2e-password';
const NEW_PROJECT_EMAIL = 'new-project-iphone-e2e@example.test';
const INACTIVE_QUEUE_EMAIL = 'inactive-project-queue-e2e@example.test';
const DISCOVERY_CANCELLATION_EMAIL = 'cloud-discovery-cancellation-e2e@example.test';
const PROJECT_ID = 'proj_xplore_aviation_e2e';
const QUEUED_PHONE_NOTE = 'Queued on iPhone before reload — preserve this newer survey note.';

const signIn = async (
  page: import('@playwright/test').Page,
  email = EMAIL,
  password = PASSWORD,
) => {
  await page.evaluate(async ({ email, password }) => {
    const firebase = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    await firebase.signInForFirebaseE2E(email, password);
  }, { email, password });
  const projectEntry = page.getByRole('button', { name: 'Choose project' })
    .or(page.getByRole('button', { name: 'Manage projects' }));
  await expect(projectEntry).toBeVisible({ timeout: 30_000 });
};

const seedLegacyXploreProject = async (page: import('@playwright/test').Page) => {
  await page.evaluate(async projectId => {
    const storage = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const originalRef = storage.makeSiteCaptureAssetRef(projectId, 'capture-xplore', 'original');
    const workingRef = storage.makeSiteCaptureAssetRef(projectId, 'capture-xplore', 'working');
    const thumbnailRef = storage.makeSiteCaptureAssetRef(projectId, 'capture-xplore', 'thumbnail');
    await Promise.all([
      storage.putSiteCaptureAsset(originalRef, new Blob(['original-photo'], { type: 'image/jpeg' })),
      storage.putSiteCaptureAsset(workingRef, new Blob(['working-photo'], { type: 'image/jpeg' })),
      storage.putSiteCaptureAsset(thumbnailRef, new Blob(['thumbnail-photo'], { type: 'image/jpeg' })),
    ]);

    const contour = Array.from({ length: 60_000 }, (_, index) => ({ x: index % 1200, y: Math.floor(index / 1200) }));
    const signImage = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='260'%3E%3Crect width='800' height='260' fill='%231e3a8a'/%3E%3Ctext x='400' y='140' text-anchor='middle' fill='white'%3EXPLORE AVIATION%3C/text%3E%3C/svg%3E";
    const now = Date.now();
    const project = {
      user: { uid: 'guest_legacy_phone', displayName: 'Legacy Phone', email: null, photoURL: null },
      projectId,
      projectName: 'Xplore aviation',
      canvases: [{
        id: 'canvas-xplore', name: 'Front elevation', backgroundImage: '',
        backgroundSize: { width: 1920, height: 1080 },
        signs: [{
          id: 'sign-xplore', name: 'Detected fascia', image: signImage,
          corners: [{ x: 200, y: 200 }, { x: 1000, y: 200 }, { x: 1000, y: 460 }, { x: 200, y: 460 }],
          signType: 'fascia_non_ill', extrusionEnabled: true, extrusionDepth: 15,
          extrusionAngle: 45, extrusionMode: 'backed', backingDepth: 5,
          opacity: 1, blendMode: 'normal', sideColor: '#1e3a8a',
          elements: [{ id: 'letters', name: 'Letters', enabled: true, depth: 15, contours: [contour] }],
          elementsSourceSize: { width: 800, height: 260 }, elementDepthModel: 'relative-width-v1',
        }],
        activeSignId: 'sign-xplore', dimensions: [], activeDimensionId: null,
        annotations: [], calibration: null, sheetTitle: 'FRONT ELEVATION', sheetNumber: 'A-101',
      }],
      activeCanvasId: 'canvas-xplore', isNightMode: false, showDimensions: true, unitSystem: 'metric',
      titleBlock: {
        enabled: false, viewMode: 'canvas', paperSize: 'A3', orientation: 'landscape',
        style: { id: 'default', name: 'Default', layout: 'vertical-right', headerColor: '#000000', textColor: '#ffffff', backgroundColor: '#ffffff', fontFamily: 'Arial', logoPosition: 'top' },
        logoImage: null, fields: [], revisions: [],
      },
      buildingModel: undefined, savedTemplates: [], notes: 'Legacy iPhone aviation survey', referenceImages: [],
      siteCaptures: [{
        id: 'capture-xplore', label: 'Front elevation', originalRef, workingRef, thumbnailRef,
        fileName: 'xplore-front.jpg', mimeType: 'image/jpeg', byteSize: 14,
        pixelWidth: 4032, pixelHeight: 3024, workingPixelWidth: 1920, workingPixelHeight: 1440,
        capturedAt: now, notes: '', supportingPhotos: [],
        referenceWall: { wallName: 'Front wall', widthMm: 12000, heightMm: 6000, planeDepthMm: 500, planeDepthDirection: 'behind', referencePlaneName: 'Main facade', method: 'laser', notes: '' },
      }],
      lastSaved: now, cloudRevision: 0, isOnline: true, isSyncing: false,
    };
    await storage.StorageService.saveProjectLocal(project as any);
  }, PROJECT_ID);
};

test('iPhone keeps Xplore cloud-saved, preserves a queued newer edit, and clean devices restore it', async ({ browser, page }) => {
  await page.goto('/?mobileCapture=1');
  await signIn(page);
  await seedLegacyXploreProject(page);

  const seeded = await page.evaluate(async projectId => {
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const local = await StorageService.loadProjectLocal(projectId);
    return { name: local?.projectName, projectId: local?.projectId };
  }, PROJECT_ID);
  expect(seeded).toEqual({ name: 'Xplore aviation', projectId: PROJECT_ID });

  await page.getByRole('button', { name: 'Choose project' }).click();
  const picker = page.getByLabel('Saved projects');
  await picker.getByRole('button', { name: /Xplore aviation/ }).click();
  await expect(page.getByRole('button', { name: 'Choose project' })).toContainText('Xplore aviation', { timeout: 30_000 });

  // Let the first large Storage-backed save finish before independently
  // reading its Firestore pointer and payload. Polling cloud while the 60,000-
  // point upload is still in flight adds avoidable WebKit/emulator contention.
  await expect(page.getByText('Cloud saved', { exact: true })).toBeVisible({ timeout: 90_000 });

  await expect.poll(() => page.evaluate(async projectId => {
    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    if (!auth.currentUser) return null;
    const cloud = await StorageService.loadProjectCloud(auth.currentUser.uid, projectId);
    return cloud ? {
      name: cloud.projectName,
      contours: cloud.canvases[0].signs[0].elements?.[0].contours[0].length,
      captureRef: cloud.siteCaptures[0].originalRef,
    } : null;
  }, PROJECT_ID), { timeout: 60_000 }).toEqual({
    name: 'Xplore aviation',
    contours: 60_000,
    captureRef: expect.stringMatching(/^http/),
  });

  await page.waitForTimeout(12_000);
  await expect(page.getByText('Cloud saved', { exact: true })).toBeVisible({ timeout: 30_000 });

  const cloudProjects = await page.evaluate(async () => {
    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    return (await StorageService.listProjectsCloud(auth.currentUser!.uid)).map(project => project.name);
  });
  expect(cloudProjects).toContain('Xplore aviation');

  const initialCloudLastSaved = await page.evaluate(async projectId => {
    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    return (await StorageService.loadProjectCloud(auth.currentUser!.uid, projectId))?.lastSaved ?? 0;
  }, PROJECT_ID);

  // Reproduce the real iPhone failure mode without stopping the local Vite
  // server: make the app observe an offline connection, queue a newer visible
  // edit in IndexedDB, then restore connectivity immediately before reloading.
  // No `online` event is dispatched, so the pre-reload 10-second retry cannot
  // flush the queue and hide a bootstrap ordering bug.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.getByText('Offline — saved on phone', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  const phoneProjectNotes = page.getByPlaceholder('Access, power, installation conditions, client instructions…');
  await phoneProjectNotes.fill(QUEUED_PHONE_NOTE);
  await expect(phoneProjectNotes).toHaveValue(QUEUED_PHONE_NOTE);

  await expect.poll(() => page.evaluate(async ({ projectId, initialCloudLastSaved }) => {
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const local = await StorageService.loadProjectLocal(projectId);
    const queued = await new Promise<boolean>((resolve, reject) => {
      const open = indexedDB.open('SignageProDB');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const request = database.transaction('syncQueue', 'readonly').objectStore('syncQueue').get(projectId);
        request.onerror = () => {
          database.close();
          reject(request.error);
        };
        request.onsuccess = () => {
          database.close();
          resolve(Boolean(request.result));
        };
      };
    });
    return {
      notes: local?.notes,
      queued,
      newerThanCloud: (local?.lastSaved ?? 0) > initialCloudLastSaved,
    };
  }, { projectId: PROJECT_ID, initialCloudLastSaved }), { timeout: 30_000 }).toEqual({
    notes: QUEUED_PHONE_NOTE,
    queued: true,
    newerThanCloud: true,
  });

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Choose project' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Choose project' })).toContainText('Xplore aviation', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByPlaceholder('Access, power, installation conditions, client instructions…')).toHaveValue(QUEUED_PHONE_NOTE, { timeout: 45_000 });
  await expect(page.getByText('Cloud saved', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(async projectId => {
    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    return (await StorageService.loadProjectCloud(auth.currentUser!.uid, projectId))?.notes;
  }, PROJECT_ID), { timeout: 60_000 }).toBe(QUEUED_PHONE_NOTE);
  await page.waitForTimeout(12_000);
  await expect(page.getByText('Cloud saved', { exact: true })).toBeVisible({ timeout: 30_000 });

  for (const device of [
    { name: 'iPad', context: devices['iPad Pro 11'] },
    { name: 'desktop', context: { viewport: { width: 1440, height: 900 } } },
  ]) {
    await test.step(`${device.name} sees and restores the phone project without local data`, async () => {
      const cleanDevice = await browser.newContext(device.context);
      const cleanPage = await cleanDevice.newPage();
      await cleanPage.goto('http://127.0.0.1:4174/');
      const hadLocalXploreBeforeSignIn = await cleanPage.evaluate(async projectId => {
        const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
        return Boolean(await StorageService.loadProjectLocal(projectId));
      }, PROJECT_ID);
      expect(hadLocalXploreBeforeSignIn).toBe(false);
      await signIn(cleanPage);
      await expect(cleanPage.getByRole('heading', { name: 'Xplore aviation', level: 1 })).toBeVisible({ timeout: 90_000 });
      await expect(cleanPage.getByText(/^Cloud saved/)).toBeVisible({ timeout: 30_000 });
      await cleanPage.getByRole('button', { name: 'Notes', exact: true }).click();
      await expect(cleanPage.getByPlaceholder('Type general project notes here...')).toHaveValue(QUEUED_PHONE_NOTE, { timeout: 30_000 });
      await cleanPage.getByRole('button', { name: 'Manage projects' }).click();
      const xploreProject = cleanPage.getByRole('heading', { name: 'Xplore aviation', level: 4 });
      await expect(xploreProject).toBeVisible({ timeout: 30_000 });
      await xploreProject.click();
      await expect(cleanPage.getByRole('heading', { name: 'Xplore aviation', level: 1 })).toBeVisible({ timeout: 45_000 });
      await expect(cleanPage.getByText(/^Cloud saved/)).toBeVisible({ timeout: 30_000 });
      await cleanDevice.close();
    });
  }
});

test('a new authenticated iPhone project uploads immediately and opens on a clean iPad', async ({ browser, page }) => {
  await page.goto('/?mobileCapture=1');
  await signIn(page, NEW_PROJECT_EMAIL);

  await page.getByRole('button', { name: 'Choose project' }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByText('Cloud saved', { exact: true })).toBeVisible({ timeout: 60_000 });

  const created = await page.evaluate(async () => {
    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const projects = await StorageService.listProjectsCloud(auth.currentUser!.uid);
    return projects.find(project => project.name === 'Untitled Project') ?? null;
  });
  expect(created).toEqual(expect.objectContaining({
    id: expect.stringMatching(/^proj_/),
    name: 'Untitled Project',
  }));

  const cleanIpad = await browser.newContext(devices['iPad Pro 11']);
  const ipadPage = await cleanIpad.newPage();
  await ipadPage.goto('http://127.0.0.1:4174/');
  await signIn(ipadPage, NEW_PROJECT_EMAIL);
  await expect(ipadPage.getByRole('heading', { name: 'Untitled Project', level: 1 })).toBeVisible({ timeout: 45_000 });
  await expect(ipadPage.getByText(/^Cloud saved/)).toBeVisible({ timeout: 30_000 });
  const restoredProjectId = await ipadPage.evaluate(async () => {
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    return (await StorageService.listProjectsLocal())[0]?.id ?? null;
  });
  expect(restoredProjectId).toBe(created!.id);
  await cleanIpad.close();
});

test('drains a queued edit for inactive Project A after synced Project B opens', async ({ page }) => {
  test.setTimeout(180_000);
  const projectAId = 'proj_inactive_queue_a';
  const projectBId = 'proj_active_synced_b';
  const queuedNote = 'Project A phone edit queued while offline.';

  await page.goto('/?mobileCapture=1');
  await signIn(page, INACTIVE_QUEUE_EMAIL);

  const seeded = await page.evaluate(async ({ projectAId, projectBId, queuedNote }) => {
    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const uid = auth.currentUser!.uid;
    const user = { uid, displayName: 'Queue Regression', email: null, photoURL: null };
    const project = (projectId: string, projectName: string, notes: string) => ({
      user,
      projectId,
      projectName,
      canvases: [{
        id: `${projectId}-canvas`,
        name: 'Front elevation',
        backgroundImage: '',
        backgroundSize: { width: 1920, height: 1080 },
        signs: [],
        activeSignId: null,
        dimensions: [],
        activeDimensionId: null,
        annotations: [],
        calibration: null,
        sheetTitle: 'FRONT ELEVATION',
        sheetNumber: 'A-101',
      }],
      activeCanvasId: `${projectId}-canvas`,
      isNightMode: false,
      showDimensions: true,
      unitSystem: 'metric',
      titleBlock: {
        enabled: false,
        viewMode: 'canvas',
        paperSize: 'A3',
        orientation: 'landscape',
        style: {
          id: 'default', name: 'Default', layout: 'vertical-right',
          headerColor: '#000000', textColor: '#ffffff', backgroundColor: '#ffffff',
          fontFamily: 'Arial', logoPosition: 'top',
        },
        logoImage: null,
        fields: [],
        revisions: [],
      },
      buildingModel: undefined,
      savedTemplates: [],
      notes,
      referenceImages: [],
      siteCaptures: [],
      lastSaved: Date.now(),
      cloudRevision: 0,
      isOnline: true,
      isSyncing: false,
    });

    const projectB = project(projectBId, 'Project B synced', 'Authoritative cloud project.');
    const projectBResult = await StorageService.saveProject(uid, projectB as any);
    const persistedB = await StorageService.loadProjectLocal(projectBId);

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const projectA = project(projectAId, 'Project A queued', queuedNote);
    const projectAResult = await StorageService.saveProject(uid, projectA as any);
    const persistedA = await StorageService.loadProjectLocal(projectAId);
    if (!persistedA || !persistedB) throw new Error('Regression fixture did not persist both projects.');

    // Keep B newest so bootstrap opens it while A remains an inactive queued job.
    await StorageService.saveProjectLocal({ ...persistedA, lastSaved: Math.max(1, persistedB.lastSaved - 1) });
    return { projectAResult, projectBResult };
  }, { projectAId, projectBId, queuedNote });

  expect(seeded).toEqual({ projectAResult: 'queued', projectBResult: 'cloud' });
  // Let the pre-reload retry observe the forced-offline state, then restore
  // navigator.onLine without dispatching an `online` event. The reload must be
  // the event that starts the account-wide queue drain under test.
  await page.waitForTimeout(1_500);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Choose project' })).toContainText('Project B synced', { timeout: 45_000 });
  await expect(page.getByText('Cloud saved', { exact: true })).toBeVisible({ timeout: 30_000 });

  await expect.poll(() => page.evaluate(async ({ projectAId }) => {
    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const uid = auth.currentUser!.uid;
    return StorageService.hasQueuedProjectSync(uid, projectAId);
  }, { projectAId }), { timeout: 75_000 }).toBe(false);

  await expect.poll(() => page.evaluate(async ({ projectAId }) => {
    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const uid = auth.currentUser!.uid;
    const cloud = await StorageService.loadProjectCloud(uid, projectAId, undefined, true);
    return cloud?.notes ?? null;
  }, { projectAId }), { timeout: 75_000 }).toBe(queuedNote);
});

test('cloud discovery never replaces a fallback after editor interaction starts', async ({ browser, page }) => {
  test.setTimeout(180_000);
  const remoteProjectId = 'proj_discovery_cancellation_remote';
  const remoteProjectName = 'Remote discovery source';
  const remoteNote = 'This note belongs only to the previously synced cloud project.';
  const fallbackNote = 'Started on the fallback while cloud discovery was still in flight.';

  await page.goto('/?mobileCapture=1');
  await signIn(page, DISCOVERY_CANCELLATION_EMAIL);
  const seeded = await page.evaluate(async ({ remoteProjectId, remoteProjectName, remoteNote }) => {
    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const uid = auth.currentUser!.uid;
    const existing = await StorageService.loadProjectCloud(uid, remoteProjectId, undefined, true);
    const now = Math.max(Date.now(), (existing?.lastSaved ?? 0) + 1);
    const project = {
      user: { uid, displayName: 'Discovery Regression', email: null, photoURL: null },
      projectId: remoteProjectId,
      projectName: remoteProjectName,
      canvases: [{
        id: `${remoteProjectId}-canvas`,
        name: 'Cloud elevation',
        backgroundImage: '',
        backgroundSize: { width: 1920, height: 1080 },
        signs: [],
        activeSignId: null,
        dimensions: [],
        activeDimensionId: null,
        annotations: [],
        calibration: null,
        sheetTitle: 'CLOUD ELEVATION',
        sheetNumber: 'A-101',
      }],
      activeCanvasId: `${remoteProjectId}-canvas`,
      isNightMode: false,
      showDimensions: true,
      unitSystem: 'metric',
      titleBlock: {
        enabled: false,
        viewMode: 'canvas',
        paperSize: 'A3',
        orientation: 'landscape',
        style: {
          id: 'default', name: 'Default', layout: 'vertical-right',
          headerColor: '#000000', textColor: '#ffffff', backgroundColor: '#ffffff',
          fontFamily: 'Arial', logoPosition: 'top',
        },
        logoImage: null,
        fields: [],
        revisions: [],
      },
      buildingModel: undefined,
      savedTemplates: [],
      notes: remoteNote,
      referenceImages: [],
      siteCaptures: [],
      lastSaved: now,
      cloudRevision: existing?.cloudRevision ?? 0,
      isOnline: true,
      isSyncing: false,
    };
    const result = await StorageService.saveProject(uid, project as any, false, true);
    const cloud = await StorageService.loadProjectCloud(uid, remoteProjectId, undefined, true);
    return { result, projectName: cloud?.projectName, notes: cloud?.notes };
  }, { remoteProjectId, remoteProjectName, remoteNote });
  expect(seeded).toEqual({ result: 'cloud', projectName: remoteProjectName, notes: remoteNote });

  const cleanDevice = await browser.newContext(devices['iPhone 13']);
  const cleanPage = await cleanDevice.newPage();
  try {
    await cleanPage.goto('http://127.0.0.1:4174/?mobileCapture=1');
    await expect.poll(() => cleanPage.evaluate(async projectId => {
      const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
      return (await StorageService.loadProjectLocal(projectId)) ?? null;
    }, remoteProjectId)).toBeNull();

    await cleanPage.evaluate(async remoteId => {
      const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
      const originalList = StorageService.listProjectsCloud.bind(StorageService);
      const originalLoad = StorageService.loadProject.bind(StorageService);
      const gate: {
        listCalls: Array<{ uid: string; strict: boolean }>;
        heldProjectId: string | null;
        loadReturned: boolean;
        releaseLoad?: () => void;
      } = {
        listCalls: [],
        heldProjectId: null,
        loadReturned: false,
      };
      (window as any).__cloudDiscoveryInteractionGate = gate;

      StorageService.listProjectsCloud = (async (uid: string, strict = false) => {
        gate.listCalls.push({ uid, strict });
        if (gate.listCalls.length === 1) return new Promise<never>(() => undefined);
        return originalList(uid, strict);
      }) as typeof StorageService.listProjectsCloud;

      StorageService.loadProject = (async (...args: Parameters<typeof originalLoad>) => {
        const loaded = await originalLoad(...args);
        if (args[1] === remoteId && gate.heldProjectId === null) {
          gate.heldProjectId = remoteId;
          await new Promise<void>(resolve => { gate.releaseLoad = resolve; });
          gate.loadReturned = true;
        }
        return loaded;
      }) as typeof StorageService.loadProject;
    }, remoteProjectId);

    await signIn(cleanPage, DISCOVERY_CANCELLATION_EMAIL);
    await expect(cleanPage.getByRole('button', { name: 'Choose project' })).toContainText('Untitled Project');
    await expect.poll(() => cleanPage.evaluate(() => {
      const gate = (window as any).__cloudDiscoveryInteractionGate;
      return {
        listCalls: gate.listCalls.length,
        strictCalls: gate.listCalls.filter((call: { strict: boolean }) => call.strict).length,
        heldProjectId: gate.heldProjectId,
      };
    }), { timeout: 60_000 }).toEqual({
      listCalls: 2,
      strictCalls: 2,
      heldProjectId: remoteProjectId,
    });

    await cleanPage.getByRole('button', { name: 'Notes', exact: true }).click();
    const notes = cleanPage.getByPlaceholder('Access, power, installation conditions, client instructions…');
    await notes.fill(fallbackNote);
    await expect(notes).toHaveValue(fallbackNote);

    const released = await cleanPage.evaluate(() => {
      const gate = (window as any).__cloudDiscoveryInteractionGate;
      if (!gate.releaseLoad) return false;
      gate.releaseLoad();
      return true;
    });
    expect(released).toBe(true);
    await expect.poll(() => cleanPage.evaluate(
      () => (window as any).__cloudDiscoveryInteractionGate.loadReturned,
    )).toBe(true);

    await expect(cleanPage.getByRole('button', { name: 'Choose project' })).toContainText('Untitled Project');
    await expect(cleanPage.getByRole('button', { name: 'Choose project' })).not.toContainText(remoteProjectName);
    await expect(notes).toHaveValue(fallbackNote);
    await expect(cleanPage.getByText('Cloud saved', { exact: true })).toBeVisible({ timeout: 60_000 });

    const readFallbackProjectId = () => cleanPage.evaluate(async note => {
      const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
      const projects = await StorageService.listProjectsLocal();
      for (const project of projects) {
        const state = await StorageService.loadProjectLocal(project.id);
        if (state?.notes === note) return state.projectId;
      }
      return null;
    }, fallbackNote);
    await expect.poll(readFallbackProjectId, { timeout: 30_000 }).not.toBeNull();
    const fallbackProjectId = await readFallbackProjectId();
    expect(fallbackProjectId).not.toBe(remoteProjectId);

    await expect.poll(() => cleanPage.evaluate(async ({ remoteProjectId, fallbackProjectId }) => {
      const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
      const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
      const uid = auth.currentUser!.uid;
      const [remote, fallback] = await Promise.all([
        StorageService.loadProjectCloud(uid, remoteProjectId, undefined, true),
        StorageService.loadProjectCloud(uid, fallbackProjectId!, undefined, true),
      ]);
      return {
        remote: { name: remote?.projectName ?? null, notes: remote?.notes ?? null },
        fallback: { id: fallback?.projectId ?? null, notes: fallback?.notes ?? null },
      };
    }, { remoteProjectId, fallbackProjectId }), { timeout: 60_000 }).toEqual({
      remote: { name: remoteProjectName, notes: remoteNote },
      fallback: { id: fallbackProjectId, notes: fallbackNote },
    });
  } finally {
    await cleanDevice.close();
  }
});
