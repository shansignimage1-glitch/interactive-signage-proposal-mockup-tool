import { chromium, devices, expect, test, webkit, type Locator, type Page } from '@playwright/test';

const APP_URL = process.env.SURVEY_E2E_BASE_URL ?? 'http://127.0.0.1:4174';
const EMAIL = 'site-survey-cross-device-e2e@example.test';
const PASSWORD = 'site-survey-cross-device-e2e-password';
const PROJECT_ID = 'proj_site_survey_cross_device_e2e';
const PROJECT_NAME = 'Cape Town site survey';
const PROJECT_NOTE = 'Project note: client requires after-hours installation access.';
const ELEVATION_NOTE = 'Elevation note: canopy fascia has corrosion above the entrance.';
const MEASUREMENT_NOTE = 'Measurement note: laser taken from the curb datum with a clear line of sight.';
const ANNOTATION_EMAIL = 'site-capture-annotation-e2e@example.test';
const ANNOTATION_PASSWORD = 'site-capture-annotation-e2e-password';
const ANNOTATION_PROJECT_ID = 'proj_site_capture_annotation_e2e';
const ANNOTATION_PROJECT_NAME = 'iPhone marked photo survey';
const ANNOTATION_CAPTURE_ID = 'capture-phone-markup';
const ANNOTATION_CAPTURE_LABEL = 'North entrance';
const ANNOTATION_NOTE = 'Photo note: cracked panel beside the right-hand fixing requires replacement.';

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

const signIn = async (page: Page, email = EMAIL, password = PASSWORD) => {
  await page.evaluate(async ({ email, password }) => {
    const firebase = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    await firebase.signInForFirebaseE2E(email, password);
  }, { email, password });
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

const seedPhoneAnnotationProject = async (page: Page) => {
  await page.evaluate(async ({ projectId, projectName, captureId, captureLabel }) => {
    const storage = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const drawing = canvas.getContext('2d')!;
    const gradient = drawing.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#dbeafe');
    gradient.addColorStop(1, '#64748b');
    drawing.fillStyle = gradient;
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.fillStyle = '#172033';
    drawing.fillRect(70, 55, 500, 360);
    drawing.fillStyle = '#d97706';
    drawing.fillRect(108, 105, 424, 34);
    drawing.fillStyle = '#e2e8f0';
    drawing.fillRect(134, 170, 372, 205);

    const photoBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Could not encode the annotation fixture.')),
      'image/jpeg',
      0.92,
    ));
    const originalRef = storage.makeSiteCaptureAssetRef(projectId, captureId, 'original');
    const workingRef = storage.makeSiteCaptureAssetRef(projectId, captureId, 'working');
    const thumbnailRef = storage.makeSiteCaptureAssetRef(projectId, captureId, 'thumbnail');
    await Promise.all([
      storage.putSiteCaptureAsset(originalRef, photoBlob),
      storage.putSiteCaptureAsset(workingRef, photoBlob),
      storage.putSiteCaptureAsset(thumbnailRef, photoBlob),
    ]);

    const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
    if (!auth.currentUser) throw new Error('The annotation fixture user is not signed in.');
    const now = Date.now();
    const fixture = {
      user: {
        uid: auth.currentUser.uid,
        displayName: auth.currentUser.displayName,
        email: auth.currentUser.email,
        photoURL: auth.currentUser.photoURL,
      },
      projectId,
      projectName,
      canvases: [{
        id: 'canvas-phone-markup',
        name: captureLabel,
        backgroundImage: canvas.toDataURL('image/jpeg', 0.92),
        backgroundSize: { width: 640, height: 480 },
        siteCaptureLink: { captureId, annotationUpdatedAt: now },
        signs: [],
        activeSignId: null,
        dimensions: [],
        activeDimensionId: null,
        annotations: [],
        calibration: null,
        sheetTitle: 'NORTH ENTRANCE',
        sheetNumber: 'A-201',
      }],
      activeCanvasId: 'canvas-phone-markup',
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
      notes: '',
      referenceImages: [],
      siteCaptures: [{
        id: captureId,
        label: captureLabel,
        originalRef,
        workingRef,
        thumbnailRef,
        fileName: 'north-entrance.jpg',
        mimeType: 'image/jpeg',
        byteSize: photoBlob.size,
        pixelWidth: 640,
        pixelHeight: 480,
        workingPixelWidth: 640,
        workingPixelHeight: 480,
        capturedAt: now,
        notes: '',
        annotations: [],
        supportingPhotos: [],
        referenceWall: {
          wallName: 'North entrance wall',
          widthMm: 8_000,
          heightMm: 4_000,
          planeDepthMm: 250,
          planeDepthDirection: 'behind',
          referencePlaneName: 'Entrance glazing',
          method: 'laser',
          notes: '',
        },
        promotedCanvasId: 'canvas-phone-markup',
      }],
      lastSaved: now,
      cloudRevision: 0,
      isOnline: true,
      isSyncing: false,
    } as any;
    await storage.StorageService.saveProjectLocal(fixture);
    const cloudSeed = await storage.StorageService.saveProject(auth.currentUser.uid, fixture);
    if (cloudSeed !== 'cloud') throw new Error(`Annotation fixture cloud seed returned ${cloudSeed}.`);
  }, {
    projectId: ANNOTATION_PROJECT_ID,
    projectName: ANNOTATION_PROJECT_NAME,
    captureId: ANNOTATION_CAPTURE_ID,
    captureLabel: ANNOTATION_CAPTURE_LABEL,
  });
};

const readAnnotationSnapshot = (page: Page, source: 'cloud' | 'local') => page.evaluate(async ({ projectId, captureId, source }) => {
  const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
  const project = source === 'cloud'
    ? await (async () => {
      const { auth } = await import(/* @vite-ignore */ ('/firebase.ts' as string));
      return auth.currentUser
        ? StorageService.loadProjectCloud(auth.currentUser.uid, projectId, undefined, true, true)
        : null;
    })()
    : await StorageService.loadProjectLocal(projectId);
  const capture = project?.siteCaptures?.find(item => item.id === captureId);
  const canvas = project?.canvases.find(item => item.id === capture?.promotedCanvasId);
  if (!project || !capture || !canvas) return null;
  return {
    projectName: project.projectName,
    capture: {
      notes: capture.notes,
      originalRef: capture.originalRef,
      workingRef: capture.workingRef,
      annotationBaseRef: capture.annotationBaseRef ?? null,
      annotationUpdatedAt: capture.annotationUpdatedAt ?? null,
      annotations: (capture.annotations ?? []).map(stroke => ({
        color: stroke.color,
        width: stroke.width,
        points: stroke.points.map(point => ({ x: point.x, y: point.y, pressure: point.pressure ?? null })),
      })),
    },
    promotedCanvas: {
      id: canvas.id,
      backgroundImage: canvas.backgroundImage,
    },
  };
}, { projectId: ANNOTATION_PROJECT_ID, captureId: ANNOTATION_CAPTURE_ID, source });

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

test('iPhone Draw & Note pen markup syncs the marked photo and note to clean iPad and desktop', async () => {
  test.setTimeout(420_000);

  const webkitBrowser = await webkit.launch();
  const chromiumBrowser = await chromium.launch();
  const contexts: import('@playwright/test').BrowserContext[] = [];

  try {
    const phoneContext = await webkitBrowser.newContext({ ...devices['iPhone 13'], baseURL: APP_URL });
    contexts.push(phoneContext);
    const phone = await phoneContext.newPage();
    await phone.goto('/?mobileCapture=1');
    await signIn(phone, ANNOTATION_EMAIL, ANNOTATION_PASSWORD);
    await seedPhoneAnnotationProject(phone);

    await phone.getByRole('button', { name: 'Choose project' }).click();
    const picker = phone.getByLabel('Saved projects');
    await picker.getByRole('button', { name: new RegExp(ANNOTATION_PROJECT_NAME, 'i') }).click();
    await expect(phone.getByRole('button', { name: 'Choose project' })).toContainText(ANNOTATION_PROJECT_NAME, { timeout: 30_000 });

    await expect.poll(async () => {
      const snapshot = await readAnnotationSnapshot(phone, 'cloud');
      return snapshot ? {
        projectName: snapshot.projectName,
        annotationCount: snapshot.capture.annotations.length,
        note: snapshot.capture.notes,
        originalHosted: /^https?:\/\//.test(snapshot.capture.originalRef),
        workingHosted: /^https?:\/\//.test(snapshot.capture.workingRef),
        canvasHosted: /^https?:\/\//.test(snapshot.promotedCanvas.backgroundImage),
      } : null;
    }, { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }).toEqual({
      projectName: ANNOTATION_PROJECT_NAME,
      annotationCount: 0,
      note: '',
      originalHosted: true,
      workingHosted: true,
      canvasHosted: true,
    });
    const initialCloud = await readAnnotationSnapshot(phone, 'cloud');
    expect(initialCloud).not.toBeNull();
    if (!initialCloud) throw new Error('The initial annotation fixture did not reach Firebase.');
    expect(initialCloud.capture.originalRef).not.toBe(initialCloud.capture.workingRef);

    await phone.getByRole('button', { name: 'Draw & Note', exact: true }).click();
    const annotationDialog = phone.getByRole('dialog', { name: 'Draw & Note' });
    await expect(annotationDialog).toBeVisible();
    const annotationCanvas = annotationDialog.getByTestId('capture-annotation-canvas');
    await expect(annotationCanvas).toBeVisible();
    await expect(annotationCanvas).toHaveClass(/opacity-100/, { timeout: 30_000 });

    const box = await annotationCanvas.boundingBox();
    if (!box) throw new Error('The iPhone annotation canvas had no drawable bounds.');
    const dispatchPenStroke = async (pointerId: number, points: Array<[number, number, number]>) => {
      const [first, ...rest] = points;
      await annotationCanvas.dispatchEvent('pointerdown', {
        pointerId,
        pointerType: 'pen',
        isPrimary: true,
        button: 0,
        buttons: 1,
        pressure: first[2],
        clientX: box.x + box.width * first[0],
        clientY: box.y + box.height * first[1],
      });
      for (const [x, y, pressure] of rest) {
        await annotationCanvas.dispatchEvent('pointermove', {
          pointerId,
          pointerType: 'pen',
          isPrimary: true,
          button: -1,
          buttons: 1,
          pressure,
          clientX: box.x + box.width * x,
          clientY: box.y + box.height * y,
        });
      }
      const last = points[points.length - 1];
      await annotationCanvas.dispatchEvent('pointerup', {
        pointerId,
        pointerType: 'pen',
        isPrimary: true,
        button: 0,
        buttons: 0,
        pressure: 0,
        clientX: box.x + box.width * last[0],
        clientY: box.y + box.height * last[1],
      });
    };
    await dispatchPenStroke(41, [[0.18, 0.25, 0.35], [0.32, 0.38, 0.55], [0.48, 0.30, 0.72]]);
    await dispatchPenStroke(42, [[0.58, 0.56, 0.42], [0.70, 0.68, 0.64], [0.82, 0.52, 0.50]]);
    await expect(annotationDialog.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await annotationDialog.getByRole('textbox', { name: 'Photo note' }).fill(ANNOTATION_NOTE);
    await annotationDialog.getByRole('button', { name: 'Save annotation' }).click();
    await expect(annotationDialog).toBeHidden({ timeout: 30_000 });

    await expect.poll(async () => {
      const snapshot = await readAnnotationSnapshot(phone, 'cloud');
      return snapshot ? {
        note: snapshot.capture.notes,
        annotationCount: snapshot.capture.annotations.length,
        pointCounts: snapshot.capture.annotations.map(stroke => stroke.points.length),
        allPenPressuresSaved: snapshot.capture.annotations.every(stroke => stroke.points.some(point => (point.pressure ?? 0) > 0)),
        originalUnchanged: snapshot.capture.originalRef === initialCloud.capture.originalRef,
        workingChanged: snapshot.capture.workingRef !== initialCloud.capture.workingRef,
        workingHosted: /^https?:\/\//.test(snapshot.capture.workingRef),
        annotationBaseHosted: /^https?:\/\//.test(snapshot.capture.annotationBaseRef ?? ''),
        promotedBackgroundChanged: snapshot.promotedCanvas.backgroundImage !== initialCloud.promotedCanvas.backgroundImage,
        promotedBackgroundHosted: /^https?:\/\//.test(snapshot.promotedCanvas.backgroundImage),
      } : null;
    }, { timeout: 120_000, intervals: [1_000, 2_000, 5_000] }).toEqual({
      note: ANNOTATION_NOTE,
      annotationCount: 2,
      pointCounts: [3, 3],
      allPenPressuresSaved: true,
      originalUnchanged: true,
      workingChanged: true,
      workingHosted: true,
      annotationBaseHosted: true,
      promotedBackgroundChanged: true,
      promotedBackgroundHosted: true,
    });
    await expect(phone.getByText('Cloud saved', { exact: true })).toBeVisible({ timeout: 30_000 });
    const annotatedCloud = await readAnnotationSnapshot(phone, 'cloud');
    expect(annotatedCloud).not.toBeNull();
    if (!annotatedCloud) throw new Error('The marked photo revision did not reach Firebase.');
    await phoneContext.close();

    const deviceEditors = [
      { name: 'iPad WebKit', browser: webkitBrowser, device: devices['iPad Pro 11'] },
      { name: 'desktop Chromium', browser: chromiumBrowser, device: devices['Desktop Chrome'] },
    ];
    for (const editor of deviceEditors) {
      await test.step(`${editor.name} restores the iPhone markup and marked editor background`, async () => {
        const context = await editor.browser.newContext({ ...editor.device, baseURL: APP_URL });
        contexts.push(context);
        const page = await context.newPage();
        await page.goto('/');
        expect(await readAnnotationSnapshot(page, 'local')).toBeNull();
        await signIn(page, ANNOTATION_EMAIL, ANNOTATION_PASSWORD);
        await expect(page.getByRole('heading', { name: ANNOTATION_PROJECT_NAME, level: 1 })).toBeVisible({ timeout: 90_000 });
        await expect.poll(() => readAnnotationSnapshot(page, 'local'), {
          timeout: 60_000,
          intervals: [1_000, 2_000, 5_000],
        }).toEqual(annotatedCloud);

        const restored = await readAnnotationSnapshot(page, 'local');
        expect(restored?.capture.originalRef).toBe(initialCloud.capture.originalRef);
        expect(restored?.capture.workingRef).toBe(annotatedCloud.capture.workingRef);
        expect(restored?.capture.workingRef).not.toBe(initialCloud.capture.workingRef);
        expect(restored?.promotedCanvas.backgroundImage).toBe(annotatedCloud.promotedCanvas.backgroundImage);
        expect(restored?.promotedCanvas.backgroundImage).not.toBe(initialCloud.promotedCanvas.backgroundImage);

        await page.getByRole('button', { name: 'Survey', exact: true }).click();
        const panel = page.getByTestId('site-survey-panel');
        await expect(panel).toBeVisible();
        const markedPhoto = panel.getByTestId('survey-marked-photo');
        await expect(markedPhoto).toBeVisible();
        await expect(panel.getByTestId('survey-annotation-count')).toHaveText('2 phone marks');
        await expectSurveyField(panel, 'survey-elevation-notes', new RegExp(ANNOTATION_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        const markedImage = markedPhoto.getByRole('img', { name: `${ANNOTATION_CAPTURE_LABEL} phone markup` });
        await expect(markedImage).toBeVisible();
        await expect.poll(() => markedImage.evaluate(image => (image as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
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
