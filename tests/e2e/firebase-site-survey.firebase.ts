import { chromium, devices, expect, test, webkit, type Locator, type Page } from '@playwright/test';

const APP_URL = process.env.SURVEY_E2E_BASE_URL ?? 'http://127.0.0.1:4174';
const EMAIL = 'site-survey-cross-device-e2e@example.test';
const PASSWORD = 'site-survey-cross-device-e2e-password';
const PROJECT_ID = 'proj_site_survey_cross_device_e2e';
const PROJECT_NAME = 'Cape Town site survey';
const PROJECT_NOTE = 'Project note: client requires after-hours installation access.';
const ELEVATION_NOTE = 'Elevation note: canopy fascia has corrosion above the entrance.';
const MEASUREMENT_NOTE = 'Measurement note: laser taken from the curb datum with a clear line of sight.';

const addGpsExif = (jpeg: Buffer, latitude: number, longitude: number) => {
  const tiff = Buffer.alloc(128);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);

  const gpsIfdOffset = 26;
  const latitudeOffset = 80;
  const longitudeOffset = 104;
  tiff.writeUInt16LE(4, gpsIfdOffset);

  const writeEntry = (index: number, tag: number, type: number, count: number, valueOffset: number) => {
    const offset = gpsIfdOffset + 2 + (index * 12);
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4);
    tiff.writeUInt32LE(valueOffset, offset + 8);
  };
  writeEntry(0, 1, 2, 2, 0);
  tiff.write(latitude < 0 ? 'S' : 'N', gpsIfdOffset + 10, 'ascii');
  writeEntry(1, 2, 5, 3, latitudeOffset);
  writeEntry(2, 3, 2, 2, 0);
  tiff.write(longitude < 0 ? 'W' : 'E', gpsIfdOffset + 34, 'ascii');
  writeEntry(3, 4, 5, 3, longitudeOffset);
  tiff.writeUInt32LE(0, gpsIfdOffset + 50);

  const writeCoordinate = (offset: number, coordinate: number) => {
    const absolute = Math.abs(coordinate);
    const degrees = Math.floor(absolute);
    const minutesWithFraction = (absolute - degrees) * 60;
    const minutes = Math.floor(minutesWithFraction);
    const secondsTimesTenThousand = Math.round((minutesWithFraction - minutes) * 60 * 10_000);
    for (const [index, numerator, denominator] of [
      [0, degrees, 1],
      [1, minutes, 1],
      [2, secondsTimesTenThousand, 10_000],
    ] as const) {
      tiff.writeUInt32LE(numerator, offset + (index * 8));
      tiff.writeUInt32LE(denominator, offset + (index * 8) + 4);
    }
  };
  writeCoordinate(latitudeOffset, latitude);
  writeCoordinate(longitudeOffset, longitude);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1Header = Buffer.alloc(4);
  app1Header[0] = 0xff;
  app1Header[1] = 0xe1;
  app1Header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1Header, payload, jpeg.subarray(2)]);
};

const EXPECTED_SURVEY = {
  projectName: PROJECT_NAME,
  projectNote: PROJECT_NOTE,
  capture: {
    label: 'Front elevation',
    elevationNote: ELEVATION_NOTE,
    location: {
      latitude: -33.9249,
      longitude: 18.4241,
      accuracy: 8,
      address: '1 Test Street, Cape Town',
    },
    referenceWall: {
      wallName: 'Front wall',
      widthMm: 12_000,
      heightMm: 6_200,
      planeDepthMm: 500,
      planeDepthDirection: 'forward',
      referencePlaneName: 'Main shopfront datum',
      method: 'laser',
      measurementNote: MEASUREMENT_NOTE,
    },
  },
};

const signIn = async (page: Page) => {
  await page.evaluate(async ({ email, password }) => {
    const firebase = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    await firebase.signInForFirebaseE2E(email, password);
  }, { email: EMAIL, password: PASSWORD });
  const projectEntry = page.getByRole('button', { name: 'Choose project' })
    .or(page.getByRole('button', { name: 'Manage projects' }));
  await expect(projectEntry).toBeVisible({ timeout: 30_000 });
};

const seedPhoneSurvey = async (page: Page) => {
  await page.evaluate(async ({
    projectId,
    projectName,
    projectNote,
    elevationNote,
    measurementNote,
  }) => {
    const storage = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const captureId = 'capture-front-survey';
    const originalRef = storage.makeSiteCaptureAssetRef(projectId, captureId, 'original');
    const workingRef = storage.makeSiteCaptureAssetRef(projectId, captureId, 'working');
    const thumbnailRef = storage.makeSiteCaptureAssetRef(projectId, captureId, 'thumbnail');
    await Promise.all([
      storage.putSiteCaptureAsset(originalRef, new Blob(['survey-original'], { type: 'image/jpeg' })),
      storage.putSiteCaptureAsset(workingRef, new Blob(['survey-working'], { type: 'image/jpeg' })),
      storage.putSiteCaptureAsset(thumbnailRef, new Blob(['survey-thumbnail'], { type: 'image/jpeg' })),
    ]);

    const now = Date.now();
    const project = {
      user: { uid: 'guest_site_survey_phone', displayName: 'Legacy Phone', email: null, photoURL: null },
      projectId,
      projectName,
      canvases: [{
        id: 'canvas-front-survey',
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
      activeCanvasId: 'canvas-front-survey',
      isNightMode: false,
      showDimensions: true,
      unitSystem: 'metric',
      titleBlock: {
        enabled: false,
        viewMode: 'canvas',
        paperSize: 'A3',
        orientation: 'landscape',
        style: {
          id: 'default',
          name: 'Default',
          layout: 'vertical-right',
          headerColor: '#000000',
          textColor: '#ffffff',
          backgroundColor: '#ffffff',
          fontFamily: 'Arial',
          logoPosition: 'top',
        },
        logoImage: null,
        fields: [],
        revisions: [],
      },
      buildingModel: undefined,
      savedTemplates: [],
      notes: projectNote,
      referenceImages: [],
      siteCaptures: [{
        id: captureId,
        label: 'Front elevation',
        originalRef,
        workingRef,
        thumbnailRef,
        fileName: 'front-survey.jpg',
        mimeType: 'image/jpeg',
        byteSize: 15,
        pixelWidth: 4032,
        pixelHeight: 3024,
        workingPixelWidth: 1920,
        workingPixelHeight: 1440,
        capturedAt: now,
        notes: elevationNote,
        location: {
          latitude: -33.9249,
          longitude: 18.4241,
          accuracy: 8,
          address: '1 Test Street, Cape Town',
        },
        supportingPhotos: [],
        referenceWall: {
          wallName: 'Front wall',
          widthMm: 12_000,
          heightMm: 6_200,
          planeDepthMm: 500,
          planeDepthDirection: 'forward',
          referencePlaneName: 'Main shopfront datum',
          method: 'laser',
          notes: measurementNote,
        },
        promotedCanvasId: 'canvas-front-survey',
      }],
      lastSaved: now,
      cloudRevision: 0,
      isOnline: true,
      isSyncing: false,
    };
    await storage.StorageService.saveProjectLocal(project as any);
  }, {
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    projectNote: PROJECT_NOTE,
    elevationNote: ELEVATION_NOTE,
    measurementNote: MEASUREMENT_NOTE,
  });
};

const readSurveySnapshot = (page: Page, source: 'cloud' | 'local') => page.evaluate(async ({ projectId, source }) => {
  const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
  const project = source === 'cloud'
    ? await (async () => {
      const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
      return auth.currentUser ? StorageService.loadProjectCloud(auth.currentUser.uid, projectId) : null;
    })()
    : await StorageService.loadProjectLocal(projectId);
  const capture = project?.siteCaptures?.[0];
  if (!project || !capture) return null;
  return {
    projectName: project.projectName,
    projectNote: project.notes,
    capture: {
      label: capture.label,
      elevationNote: capture.notes,
      location: capture.location ? {
        latitude: capture.location.latitude,
        longitude: capture.location.longitude,
        accuracy: capture.location.accuracy,
        address: capture.location.address,
      } : null,
      referenceWall: {
        wallName: capture.referenceWall.wallName,
        widthMm: capture.referenceWall.widthMm,
        heightMm: capture.referenceWall.heightMm,
        planeDepthMm: capture.referenceWall.planeDepthMm,
        planeDepthDirection: capture.referenceWall.planeDepthDirection,
        referencePlaneName: capture.referenceWall.referencePlaneName,
        method: capture.referenceWall.method,
        measurementNote: capture.referenceWall.notes,
      },
    },
  };
}, { projectId: PROJECT_ID, source });

const readFieldValue = (field: Locator) => field.evaluate(element => {
  const value = (element as HTMLInputElement | HTMLTextAreaElement).value;
  return (typeof value === 'string' ? value : element.textContent ?? '').trim();
});

const expectSurveyField = async (panel: Locator, testId: string, expected: RegExp) => {
  const field = panel.getByTestId(testId);
  await expect(field).toBeVisible();
  await expect.poll(() => readFieldValue(field)).toMatch(expected);
};

test('iPhone capture stores photo GPS and prefers it to a different live device position', async () => {
  test.setTimeout(90_000);
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    baseURL: APP_URL,
    geolocation: { latitude: -34.5, longitude: 19.5, accuracy: 50 },
    permissions: ['geolocation'],
  });

  try {
    const page = await context.newPage();
    await page.goto('/?mobileCapture=1');
    await page.getByRole('button', { name: 'Continue as Guest' }).click();
    const mobile = page.getByTestId('mobile-site-capture');
    await expect(mobile).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose project' })).toContainText('Untitled Project');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const jpegBase64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const drawing = canvas.getContext('2d')!;
      drawing.fillStyle = '#dbeafe';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = '#0f172a';
      drawing.fillRect(40, 40, 240, 160);
      return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    });
    const gpsPhoto = addGpsExif(Buffer.from(jpegBase64, 'base64'), -33.9249, 18.4241);

    const parsedCoordinates = await page.evaluate(async jpegBytes => {
      const { coordinatesFromPhoto } = await import(/* @vite-ignore */ ('/services/PhotoLocationService.ts' as string));
      const bytes = Uint8Array.from(jpegBytes);
      return coordinatesFromPhoto(new File([bytes], 'gps-photo.jpg', { type: 'image/jpeg' }));
    }, [...gpsPhoto]);
    expect(parsedCoordinates?.latitude).toBeCloseTo(-33.9249, 4);
    expect(parsedCoordinates?.longitude).toBeCloseTo(18.4241, 4);

    await mobile.locator('input[type=file]').setInputFiles({
      name: 'gps-photo.jpg',
      mimeType: 'image/jpeg',
      buffer: gpsPhoto,
    });
    await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible({ timeout: 30_000 });

    await expect.poll(async () => page.evaluate(async () => {
      const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
      for (const metadata of await StorageService.listProjectsLocal()) {
        const project = await StorageService.loadProjectLocal(metadata.id);
        const location = project?.siteCaptures?.[0]?.location;
        if (location) return {
          latitude: location.latitude.toFixed(4),
          longitude: location.longitude.toFixed(4),
        };
      }
      return null;
    }), { timeout: 30_000 }).toEqual({ latitude: '-33.9249', longitude: '18.4241' });
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
});

test('denied geolocation prevents embedded photo GPS from being persisted', async () => {
  test.setTimeout(90_000);
  const browser = await webkit.launch();
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    baseURL: APP_URL,
  });

  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      (window as any).__geolocationPermissionRequests = 0;
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (_success: PositionCallback, error: PositionErrorCallback) => {
            (window as any).__geolocationPermissionRequests += 1;
            error({
              code: 1,
              message: 'Location permission denied by the user.',
              PERMISSION_DENIED: 1,
              POSITION_UNAVAILABLE: 2,
              TIMEOUT: 3,
            } as GeolocationPositionError);
          },
        },
      });
    });
    let geocodeRequests = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/geocode') geocodeRequests += 1;
    });

    await page.goto('/?mobileCapture=1');
    await page.getByRole('button', { name: 'Continue as Guest' }).click();
    const mobile = page.getByTestId('mobile-site-capture');
    await expect(mobile).toBeVisible();
    const jpegBase64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const drawing = canvas.getContext('2d')!;
      drawing.fillStyle = '#fee2e2';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = '#450a0a';
      drawing.fillRect(40, 40, 240, 160);
      return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    });
    const gpsPhoto = addGpsExif(Buffer.from(jpegBase64, 'base64'), -33.9249, 18.4241);

    await mobile.locator('input[type=file]').setInputFiles({
      name: 'denied-gps-photo.jpg',
      mimeType: 'image/jpeg',
      buffer: gpsPhoto,
    });
    await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible({ timeout: 30_000 });

    await expect.poll(async () => page.evaluate(async () => {
      const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
      for (const metadata of await StorageService.listProjectsLocal()) {
        const project = await StorageService.loadProjectLocal(metadata.id);
        const capture = project?.siteCaptures?.[0];
        if (capture) return { captureSaved: true, location: capture.location ?? null };
      }
      return null;
    }), { timeout: 30_000 }).toEqual({ captureSaved: true, location: null });
    expect(await page.evaluate(() => (window as any).__geolocationPermissionRequests)).toBe(1);
    expect(geocodeRequests).toBe(0);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
});

test('iPhone survey details persist to cloud and appear in clean iPad and desktop editors', async ({}, testInfo) => {
  test.setTimeout(360_000);

  const webkitBrowser = await webkit.launch();
  const chromiumBrowser = await chromium.launch();
  const contexts: import('@playwright/test').BrowserContext[] = [];

  try {
    const phoneContext = await webkitBrowser.newContext({ ...devices['iPhone 13'], baseURL: APP_URL });
    contexts.push(phoneContext);
    const phone = await phoneContext.newPage();
    await phone.goto('/?mobileCapture=1');
    await signIn(phone);
    await seedPhoneSurvey(phone);

    await phone.getByRole('button', { name: 'Choose project' }).click();
    const picker = phone.getByLabel('Saved projects');
    await picker.getByRole('button', { name: new RegExp(PROJECT_NAME, 'i') }).click();
    await expect(phone.getByRole('button', { name: 'Choose project' })).toContainText(PROJECT_NAME, { timeout: 30_000 });
    await expect(phone.getByText('Cloud saved', { exact: true })).toBeVisible({ timeout: 90_000 });

    await expect.poll(() => readSurveySnapshot(phone, 'cloud'), { timeout: 60_000 }).toEqual(EXPECTED_SURVEY);
    await phoneContext.close();

    const ipadContext = await webkitBrowser.newContext({ ...devices['iPad Pro 11'], baseURL: APP_URL });
    contexts.push(ipadContext);
    const ipad = await ipadContext.newPage();
    await ipad.goto('/');
    expect(await readSurveySnapshot(ipad, 'local')).toBeNull();
    await ipad.evaluate(async () => {
      const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
      const listProjectsCloud = StorageService.listProjectsCloud.bind(StorageService);
      (window as any).__cloudProjectListAttempts = 0;
      StorageService.listProjectsCloud = async userId => {
        (window as any).__cloudProjectListAttempts += 1;
        if ((window as any).__cloudProjectListAttempts === 1) {
          return await new Promise<never>(() => undefined);
        }
        return listProjectsCloud(userId);
      };
    });
    await signIn(ipad);
    await expect(ipad.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({ timeout: 90_000 });
    expect(await ipad.evaluate(() => (window as any).__cloudProjectListAttempts)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => readSurveySnapshot(ipad, 'local'), { timeout: 45_000 }).toEqual(EXPECTED_SURVEY);

    const desktopContext = await chromiumBrowser.newContext({ ...devices['Desktop Chrome'], baseURL: APP_URL });
    contexts.push(desktopContext);
    const desktop = await desktopContext.newPage();
    await desktop.goto('/');
    expect(await readSurveySnapshot(desktop, 'local')).toBeNull();
    await signIn(desktop);
    await expect(desktop.getByRole('heading', { name: PROJECT_NAME, level: 1 })).toBeVisible({ timeout: 90_000 });
    await expect.poll(() => readSurveySnapshot(desktop, 'local'), { timeout: 45_000 }).toEqual(EXPECTED_SURVEY);

    for (const editor of [
      { name: 'iPad WebKit', page: ipad },
      { name: 'desktop Chromium', page: desktop },
    ]) {
      await test.step(`${editor.name} exposes the complete site survey`, async () => {
        const surveyTab = editor.page.getByRole('button', { name: 'Survey', exact: true });
        await expect(surveyTab).toBeVisible({ timeout: 30_000 });
        await surveyTab.click();

        const panel = editor.page.getByTestId('site-survey-panel');
        await expect(panel).toBeVisible();
        await expectSurveyField(panel, 'survey-wall-width', /(?:12[\s,]?000(?:\.0+)?\s*mm|12(?:\.0+)?\s*m)/i);
        await expectSurveyField(panel, 'survey-wall-height', /(?:6[\s,]?200(?:\.0+)?\s*mm|6\.2(?:0+)?\s*m)/i);
        await expectSurveyField(panel, 'survey-plane-depth', /(?=.*(?:500(?:\.0+)?\s*mm|50(?:\.0+)?\s*cm|0\.5(?:0+)?\s*m))(?=.*(?:forward|closer))/i);
        await expectSurveyField(panel, 'survey-gps-coordinates', /-33\.9249(?:0+)?\s*[,/]\s*18\.4241(?:0+)?/);
        await expectSurveyField(panel, 'survey-gps-accuracy', /8(?:\.0+)?\s*m/i);
        await expectSurveyField(panel, 'survey-address', /1 Test Street, Cape Town/);
        await expectSurveyField(panel, 'survey-elevation-notes', new RegExp(ELEVATION_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        await expectSurveyField(panel, 'survey-measurement-notes', new RegExp(MEASUREMENT_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

        const calibrateByTestId = panel.getByTestId('calibrate-from-survey');
        await expect(calibrateByTestId).toBeVisible();
        await expect(calibrateByTestId).toBeEnabled();
        await expect(panel.getByRole('button', { name: 'Calibrate from survey', exact: true })).toBeVisible();
        await calibrateByTestId.click();
        await expect(editor.page.getByRole('heading', { name: 'How was this photo taken?' })).toBeVisible();
        await expect(editor.page.getByRole('button', { name: 'Angled facade' })).toBeVisible();
        await editor.page.getByRole('button', { name: 'Close calibration' }).click();
        if (editor.name === 'iPad WebKit') {
          await testInfo.attach('iPad site survey', {
            body: await editor.page.screenshot({ fullPage: true }),
            contentType: 'image/png',
          });
        }
      });
    }
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => undefined)));
    await Promise.all([
      webkitBrowser.close().catch(() => undefined),
      chromiumBrowser.close().catch(() => undefined),
    ]);
  }
});
