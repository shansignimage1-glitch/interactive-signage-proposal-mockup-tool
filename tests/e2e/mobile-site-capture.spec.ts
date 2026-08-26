import { expect, test } from '@playwright/test';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const PHONE_PROJECTS = ['iphone', 'iphone-webkit', 'android-phone'];
const CAMERA_GUIDE_PROJECTS = [...PHONE_PROJECTS, 'ipad', 'ipad-webkit'];
const CAMERA_FRAME_PROJECTS = ['iphone', 'ipad'];

test('phone and tablet cameras show a horizontal level guide and release the camera', async ({ page }, testInfo) => {
  test.skip(!CAMERA_GUIDE_PROJECTS.includes(testInfo.project.name), 'Camera guide is verified on phone and tablet browser profiles.');

  await page.addInitScript(() => {
    const lifecycle = { starts: 0, stops: 0 };
    (window as any).__cameraGuideLifecycle = lifecycle;
    const track = { stop: () => { lifecycle.stops += 1; } };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => { lifecycle.starts += 1; return { getTracks: () => [track] }; } },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null });
    HTMLMediaElement.prototype.play = async () => undefined;
    HTMLMediaElement.prototype.pause = () => undefined;
  });

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByTestId('camera-level-guide')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__cameraGuideLifecycle.starts)).toBe(0);

  await page.getByRole('button', { name: 'Open camera with level guide' }).click();
  await expect(page.getByRole('dialog', { name: 'Site camera with level guide' })).toBeVisible();
  await expect(page.getByTestId('camera-level-guide')).toBeVisible();
  await expect(page.getByText('Align the building with the line')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__cameraGuideLifecycle.starts)).toBe(1);

  await page.getByRole('button', { name: 'Close camera' }).click();
  await expect(page.getByRole('dialog', { name: 'Site camera with level guide' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__cameraGuideLifecycle.stops)).toBe(1);

  await page.getByRole('button', { name: 'Open camera with level guide' }).click();
  await expect(page.getByTestId('camera-level-guide')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(page.getByRole('dialog', { name: 'Site camera with level guide' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__cameraGuideLifecycle.stops)).toBe(2);
});

test('level-guided camera frame is saved as the elevation photograph', async ({ page }, testInfo) => {
  test.skip(!CAMERA_FRAME_PROJECTS.includes(testInfo.project.name), 'In-app frame capture is sampled on phone and tablet profiles.');

  await page.addInitScript(() => {
    const track = { stop: () => undefined };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 24 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 16 });
    Object.defineProperty(HTMLVideoElement.prototype, 'readyState', { configurable: true, get: () => 2 });
    HTMLMediaElement.prototype.play = async () => undefined;
    HTMLMediaElement.prototype.pause = () => undefined;
    (window as any).__guidedDrawCalls = 0;
    CanvasRenderingContext2D.prototype.drawImage = () => { (window as any).__guidedDrawCalls += 1; };
  });

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Open camera with level guide' }).click();
  const video = page.getByLabel('Live rear camera preview');
  await video.evaluate(element => element.dispatchEvent(new Event('loadeddata')));
  const guidedShutter = page.getByRole('button', { name: 'Capture guided photo' });
  await expect(guidedShutter).toBeEnabled();
  await guidedShutter.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });

  await expect(page.getByRole('heading', { name: 'Reference wall' })).toBeVisible();
  await page.getByRole('button', { name: 'Views' }).click();
  await expect(page.getByText('24 × 16')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__guidedDrawCalls)).toBe(1);
});

test('tablet editor camera always shows its level line and stops when inactive', async ({ page }, testInfo) => {
  test.skip(!['ipad', 'ipad-webkit'].includes(testInfo.project.name), 'The full-editor camera is the tablet capture path.');

  await page.addInitScript(() => {
    const lifecycle = { starts: 0, stops: 0 };
    (window as any).__tabletCameraLifecycle = lifecycle;
    const track = { stop: () => { lifecycle.stops += 1; } };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => { lifecycle.starts += 1; return { getTracks: () => [track] }; } },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null });
    HTMLMediaElement.prototype.play = async () => undefined;
    HTMLMediaElement.prototype.pause = () => undefined;
  });

  await page.goto('/?editor=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: /New Image \/ Camera/ }).click();
  await page.getByRole('button', { name: 'Use Camera' }).click();

  await expect(page.getByText('Take Photo')).toBeVisible();
  await expect(page.getByTestId('live-level-guide')).toBeVisible();
  await expect(page.getByText('LEVEL GUIDE')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__tabletCameraLifecycle.starts)).toBe(1);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(page.getByText('Select Image Source')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__tabletCameraLifecycle.stops)).toBe(1);
});

test('phone mode captures an original, records wall geometry, dictates notes, and creates an editor view', async ({ page }, testInfo) => {
  test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'Dedicated phone workflow is verified on iPhone and Android profiles.');

  await page.addInitScript(() => {
    class RecognitionStub {
      static invocation = 0;
      continuous = false; interimResults = false; lang = 'en-US';
      onstart?: () => void; onend?: () => void; onresult?: (event: any) => void;
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
      start() {
        this.onstart?.();
        const transcript = RecognitionStub.invocation++ === 0 ? 'twelve point five meters' : 'Power supply is above the entrance';
        this.onresult?.({ results: [[{ transcript }]] });
        this.onend?.();
      }
    }
    (window as any).SpeechRecognition = RecognitionStub;
    (window as any).webkitSpeechRecognition = RecognitionStub;
  });

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await expect(mobile).toBeVisible();
  await expect(page.getByTestId('controls-panel')).toHaveCount(0);
  await expect(page.locator('#export-target')).toHaveCount(0);

  await mobile.locator('input[type=file]').setInputFiles({ name: 'front-elevation.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible();

  const width = mobile.getByLabel('Known wall width in m');
  await width.click();
  await width.pressSequentially('12');
  await expect(width).toBeFocused();
  await mobile.getByRole('button', { name: 'Dictate known wall width' }).click();
  await expect(width).toHaveValue('12.5');

  await mobile.getByLabel('Known wall width in m').fill('12.5');
  await mobile.getByLabel('Known wall height in m').fill('6.2');
  await mobile.getByLabel('Plane depth / offset in m').fill('0.5');
  await mobile.getByRole('button', { name: 'Closer to camera' }).click();
  await mobile.getByLabel('Confirmed reference plane').fill('Main entrance façade');

  await mobile.getByRole('button', { name: 'Notes', exact: true }).click();
  await mobile.getByRole('button', { name: 'Dictate project notes' }).click();
  await expect(mobile.getByPlaceholder(/Access, power/)).toHaveValue(/Power supply is above the entrance/);

  await mobile.getByRole('button', { name: 'Views' }).click();
  await expect(mobile.getByText('1 × 1')).toBeVisible();
  await mobile.getByRole('button', { name: /Create editor view/ }).click();
  await expect(mobile.getByText('Editor ready')).toBeVisible();

  const stored = await page.evaluate(async () => {
    const request = indexedDB.open('SignageProDB');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('assets', 'readonly');
    const all = tx.objectStore('assets').getAll();
    const assets = await new Promise<any[]>((resolve, reject) => { all.onsuccess = () => resolve(all.result); all.onerror = () => reject(all.error); });
    const original = assets.find(asset => String(asset.ref).endsWith('/original'));
    return { original: original?.blob?.size ?? original?.bytes?.byteLength ?? 0, count: assets.length };
  });
  expect(stored.original).toBe(PNG_1X1.length);
  expect(stored.count).toBeGreaterThanOrEqual(3);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByTestId('mobile-site-capture')).toBeVisible();
});

test('iPhone user draws and notes on a captured image without changing the original', async ({ page }, testInfo) => {
  test.skip(!['iphone', 'iphone-webkit'].includes(testInfo.project.name), 'The annotation regression runs on both iPhone browser engines.');
  test.setTimeout(testInfo.project.name === 'iphone-webkit' ? 90_000 : 45_000);

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  const photoBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f8fafc';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#cbd5e1';
    context.fillRect(20, 20, 200, 120);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await mobile.locator('input[type=file]').setInputFiles({
    name: 'annotation-elevation.png',
    mimeType: 'image/png',
    buffer: Buffer.from(photoBase64, 'base64'),
  });
  await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible();

  const readStoredCapture = () => page.evaluate(async () => {
    const storage = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const projectId = localStorage.getItem('signagepro_guest_project_id');
    const project = projectId ? await storage.StorageService.loadProjectLocal(projectId) : null;
    const capture = project?.siteCaptures?.[0] as any;
    if (!capture) return null;
    const original = await storage.getSiteCaptureAsset(capture.originalRef);
    const bytes = new Uint8Array(await original!.arrayBuffer());
    let digest = 2166136261;
    for (const byte of bytes) {
      digest ^= byte;
      digest = Math.imul(digest, 16777619);
    }
    return {
      originalRef: capture.originalRef as string,
      originalDigest: `${bytes.byteLength}:${digest >>> 0}`,
      annotationBaseRef: capture.annotationBaseRef as string | undefined,
      workingRef: capture.workingRef as string,
      thumbnailRef: capture.thumbnailRef as string,
      notes: capture.notes as string,
      annotations: (capture.annotations ?? []) as Array<{ points: Array<{ x: number; y: number }> }>,
    };
  });

  await mobile.getByRole('button', { name: 'Choose project' }).click();
  const savedProjects = page.getByLabel('Saved projects');
  await savedProjects.getByLabel('Current project name').fill('iPhone annotation regression');
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();
  await expect.poll(readStoredCapture).not.toBeNull();
  const before = await readStoredCapture();
  expect(before).not.toBeNull();
  expect(before!.annotations).toEqual([]);
  await savedProjects.getByTestId('current-saved-project').click();

  await mobile.getByRole('button', { name: 'Views' }).click();
  await mobile.getByRole('button', { name: 'Draw & Note' }).click();
  const dialog = page.getByRole('dialog', { name: 'Draw & Note' });
  await expect(dialog).toBeVisible();
  const annotationCanvas = dialog.getByTestId('capture-annotation-canvas');
  await expect(annotationCanvas).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save annotation' })).toBeEnabled();
  await annotationCanvas.evaluate(canvas => {
    (window as any).__annotationPointerTypes = [];
    canvas.addEventListener('pointerdown', event => {
      (window as any).__annotationPointerTypes.push((event as PointerEvent).pointerType);
    });
  });

  const useTrustedPen = testInfo.project.name === 'iphone';
  const cdp = useTrustedPen ? await page.context().newCDPSession(page) : null;
  let nextTouchPointerId = 41;
  const drawPenStroke = async (points: Array<{ x: number; y: number }>) => {
    const bounds = await annotationCanvas.boundingBox();
    if (!bounds) throw new Error('Annotation canvas has no visible bounds.');
    const absolute = points.map(point => ({
      x: bounds.x + bounds.width * point.x,
      y: bounds.y + bounds.height * point.y,
    }));
    if (cdp) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: absolute[0].x, y: absolute[0].y, pointerType: 'pen',
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: absolute[0].x, y: absolute[0].y,
        button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.55, tiltX: 8, tiltY: -5,
      });
      for (const point of absolute.slice(1)) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: point.x, y: point.y,
          button: 'left', buttons: 1, pointerType: 'pen', force: 0.7, tiltX: 10, tiltY: -4,
        });
      }
      const last = absolute[absolute.length - 1];
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: last.x, y: last.y,
        button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0,
      });
      return;
    }

    const pointerId = nextTouchPointerId++;
    await annotationCanvas.evaluate((canvas, input) => {
      const emit = (type: string, point: { x: number; y: number }, buttons: number, pressure: number) => {
        canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: input.pointerId,
          pointerType: 'touch',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: type === 'pointermove' ? -1 : 0,
          buttons,
          pressure,
          width: 9,
          height: 9,
        }));
      };
      emit('pointerdown', input.points[0], 1, 0.55);
      input.points.slice(1).forEach((point, index) => emit('pointermove', point, 1, 0.62 + index * 0.06));
      emit('pointerup', input.points[input.points.length - 1], 0, 0);
    }, { points: absolute, pointerId });
  };

  await drawPenStroke([{ x: 0.15, y: 0.25 }, { x: 0.35, y: 0.4 }, { x: 0.55, y: 0.3 }]);
  await drawPenStroke([{ x: 0.2, y: 0.7 }, { x: 0.45, y: 0.6 }, { x: 0.7, y: 0.75 }]);
  await dialog.getByRole('button', { name: 'Undo' }).click();
  await dialog.getByRole('button', { name: 'Clear drawing' }).click();
  await drawPenStroke([{ x: 0.18, y: 0.55 }, { x: 0.42, y: 0.35 }, { x: 0.72, y: 0.5 }]);
  const expectedPointerType = useTrustedPen ? 'pen' : 'touch';
  expect(await page.evaluate(() => (window as any).__annotationPointerTypes)).toEqual([
    expectedPointerType, expectedPointerType, expectedPointerType,
  ]);
  await dialog.getByLabel('Photo note').fill('Crack above the left edge of the fascia.');
  await dialog.getByRole('button', { name: 'Save annotation' }).click();
  await expect(dialog).toHaveCount(0);

  await mobile.getByRole('button', { name: 'Choose project' }).click();
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();
  await expect.poll(async () => (await readStoredCapture())?.notes).toBe('Crack above the left edge of the fascia.');
  const saved = await readStoredCapture();
  expect(saved).not.toBeNull();
  expect(saved!.originalRef).toBe(before!.originalRef);
  expect(saved!.originalDigest).toBe(before!.originalDigest);
  expect(saved!.workingRef).toMatch(/^site-capture:\/\//);
  expect(saved!.thumbnailRef).toMatch(/^site-capture:\/\//);
  expect(saved!.workingRef).not.toBe(before!.workingRef);
  expect(saved!.thumbnailRef).not.toBe(before!.thumbnailRef);
  expect(saved!.annotations).toHaveLength(1);
  expect(saved!.annotations[0].points.length).toBeGreaterThanOrEqual(2);
  for (const point of saved!.annotations[0].points) {
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.x).toBeLessThanOrEqual(1);
    expect(point.y).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeLessThanOrEqual(1);
  }

  await savedProjects.getByTestId('current-saved-project').click();
  await mobile.getByRole('button', { name: 'Draw & Note' }).click();
  await expect(dialog.getByLabel('Photo note')).toHaveValue('Crack above the left edge of the fascia.');
  await expect(dialog.getByRole('button', { name: 'Undo' })).toBeEnabled();

  await drawPenStroke([{ x: 0.25, y: 0.2 }, { x: 0.5, y: 0.15 }, { x: 0.75, y: 0.25 }]);
  await dialog.getByLabel('Photo note').fill('This edit must be discarded.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await mobile.getByRole('button', { name: 'Choose project' }).click();
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();
  await page.waitForTimeout(250);
  const afterCancel = await readStoredCapture();
  expect(afterCancel).toEqual(saved);
  await savedProjects.getByTestId('current-saved-project').click();
  await mobile.getByRole('button', { name: 'Draw & Note' }).click();
  await expect(dialog.getByLabel('Photo note')).toHaveValue('Crack above the left edge of the fascia.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  if (testInfo.project.name === 'iphone') {
    // Stage one more marked image, then switch projects while its data URI is
    // still being prepared. The abandoned working/thumbnail pair must be
    // removed without touching the durable original, annotation base, or last
    // successfully saved markup. This engine-independent cleanup race runs
    // once because WebKit does not reliably honor a late FileReader prototype
    // replacement after the annotation canvas has already used FileReader.
    const abandonedProjectId = await page.evaluate(() => localStorage.getItem('signagepro_guest_project_id'));
    expect(abandonedProjectId).toBeTruthy();
    await mobile.getByRole('button', { name: 'Draw & Note' }).click();
    await drawPenStroke([{ x: 0.22, y: 0.25 }, { x: 0.48, y: 0.45 }, { x: 0.76, y: 0.32 }]);
    await page.evaluate(() => {
      const originalReadAsDataURL = FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL = function (blob: Blob) {
        const reader = this;
        (window as any).__annotationBlobReadStarted = true;
        (window as any).__resumeAnnotationBlobRead = () => {
          FileReader.prototype.readAsDataURL = originalReadAsDataURL;
          originalReadAsDataURL.call(reader, blob);
        };
      };
    });
    await dialog.getByRole('button', { name: 'Save annotation' }).click();
    await expect.poll(
      () => page.evaluate(() => Boolean((window as any).__annotationBlobReadStarted)),
    ).toBe(true);

    const listProjectAssetRefs = (projectId: string) => page.evaluate(async id => {
      const request = indexedDB.open('SignageProDB');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('assets', 'readonly');
      const all = tx.objectStore('assets').getAll();
      const assets = await new Promise<any[]>((resolve, reject) => {
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      });
      return assets.map(asset => String(asset.ref)).filter(ref => ref.startsWith(`site-capture://${id}/`)).sort();
    }, projectId);
    const retainedRefs = [saved!.originalRef, saved!.annotationBaseRef, saved!.workingRef, saved!.thumbnailRef]
      .filter((ref): ref is string => Boolean(ref));
    const stagedRefs = (await listProjectAssetRefs(abandonedProjectId!)).filter(ref => !retainedRefs.includes(ref));
    expect(stagedRefs).toHaveLength(2);
    expect(stagedRefs.some(ref => ref.includes('/working/markup_'))).toBe(true);
    expect(stagedRefs.some(ref => ref.includes('/thumbnail/markup_'))).toBe(true);

    await mobile.getByRole('button', { name: 'Choose project' }).evaluate(element => (element as HTMLButtonElement).click());
    await page.getByRole('button', { name: 'New project' }).evaluate(element => (element as HTMLButtonElement).click());
    await expect.poll(() => page.evaluate(() => localStorage.getItem('signagepro_guest_project_id'))).not.toBe(abandonedProjectId);
    await page.evaluate(() => (window as any).__resumeAnnotationBlobRead());
    await expect.poll(async () => (await listProjectAssetRefs(abandonedProjectId!)).filter(ref => stagedRefs.includes(ref))).toEqual([]);
    const retainedAfterAbort = await listProjectAssetRefs(abandonedProjectId!);
    expect(retainedAfterAbort).toEqual(expect.arrayContaining(retainedRefs));
  }
  await cdp?.detach();
});

test('zero wall dimensions show validation and keep editor-view promotion disabled', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'Wall-size validation is platform-independent and runs once on the iPhone profile.');

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.locator('input[type=file]').setInputFiles({ name: 'zero-wall.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible();

  const width = mobile.getByLabel('Known wall width in m');
  await width.fill('0');
  await mobile.getByLabel('Known wall height in m').fill('6.2');

  await expect(width).toHaveAttribute('aria-invalid', 'true');
  await expect(mobile.getByText('Enter a value greater than zero.')).toBeVisible();

  await mobile.getByRole('button', { name: 'Views' }).click();
  const promotion = mobile.getByRole('button', { name: 'Measurements required' });
  await expect(promotion).toBeVisible();
  await expect(promotion).toBeDisabled();
});

test('guest resume never opens a project that is now owned by an account', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'Guest ownership isolation is platform-independent and runs once on the iPhone profile.');

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.getByRole('button', { name: 'Choose project' }).click();
  const savedProjects = page.getByLabel('Saved projects');
  await savedProjects.getByLabel('Current project name').fill('Private account project');
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();

  const privateProjectId = await page.evaluate(async () => {
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const projectId = localStorage.getItem('signagepro_guest_project_id');
    if (!projectId) throw new Error('Guest project marker is missing.');
    const project = await StorageService.loadProjectLocal(projectId);
    if (!project) throw new Error('Guest project is missing.');
    await StorageService.saveProjectLocal({
      ...project,
      user: { uid: 'authenticated_owner', displayName: 'Account owner', email: null, photoURL: null },
    });
    return projectId;
  });

  await savedProjects.getByRole('button', { name: /Private account project/ }).click();
  await mobile.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Continue as Guest' }).click();

  await expect(mobile.getByRole('button', { name: 'Choose project' })).toContainText('Untitled Project');
  const resumedProjectId = await page.evaluate(() => localStorage.getItem('signagepro_guest_project_id'));
  expect(resumedProjectId).toBeTruthy();
  expect(resumedProjectId).not.toBe(privateProjectId);
});

test('in-flight editor-view promotion cannot write into a different project', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'The promotion project-switch race is platform-independent and runs once on the iPhone profile.');

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.locator('input[type=file]').setInputFiles({ name: 'promotion-source.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible();
  await mobile.getByLabel('Known wall width in m').fill('12');
  await mobile.getByLabel('Known wall height in m').fill('6');

  await mobile.getByRole('button', { name: 'Choose project' }).click();
  const savedProjects = page.getByLabel('Saved projects');
  await savedProjects.getByLabel('Current project name').fill('Promotion Source');
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();
  await savedProjects.getByRole('button', { name: 'New project' }).click();
  await mobile.getByRole('button', { name: 'Choose project' }).click();
  await savedProjects.getByLabel('Current project name').fill('Promotion Target');
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();
  await savedProjects.getByRole('button', { name: /Promotion Source/ }).click();

  await page.evaluate(() => {
    const readAsDataUrl = FileReader.prototype.readAsDataURL;
    (window as any).__promotionReadReleases = [];
    FileReader.prototype.readAsDataURL = function(this: FileReader, blob: Blob) {
      (window as any).__promotionReadReleases.push(() => readAsDataUrl.call(this, blob));
    };
  });

  await mobile.getByRole('button', { name: 'Views' }).click();
  await mobile.getByRole('button', { name: 'Create editor view' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__promotionReadReleases.length)).toBe(1);

  await mobile.getByRole('button', { name: 'Choose project' }).click();
  await savedProjects.getByRole('button', { name: /Promotion Target/ }).click();
  await page.evaluate(() => (window as any).__promotionReadReleases.shift()());
  await page.waitForTimeout(250);

  await mobile.getByRole('button', { name: 'Choose project' }).click();
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();
  const target = await page.evaluate(async () => {
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const metadata = (await StorageService.listProjectsLocal()).find(project => project.name === 'Promotion Target');
    const project = metadata ? await StorageService.loadProjectLocal(metadata.id) : null;
    return project ? {
      canvasCount: project.canvases.length,
      backgroundImage: project.canvases[0]?.backgroundImage ?? '',
      captureCount: project.siteCaptures?.length ?? 0,
    } : null;
  });
  expect(target).toEqual({ canvasCount: 1, backgroundImage: '', captureCount: 0 });
});

test('concurrent editor-view promotion creates exactly one canvas', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'The duplicate-promotion race is platform-independent and runs once on the iPhone profile.');

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.locator('input[type=file]').setInputFiles({ name: 'double-promotion.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible();
  await mobile.getByLabel('Known wall width in m').fill('12');
  await mobile.getByLabel('Known wall height in m').fill('6');
  await mobile.getByRole('button', { name: 'Views' }).click();

  await page.evaluate(() => {
    const readAsDataUrl = FileReader.prototype.readAsDataURL;
    (window as any).__promotionReadReleases = [];
    FileReader.prototype.readAsDataURL = function(this: FileReader, blob: Blob) {
      (window as any).__promotionReadReleases.push(() => readAsDataUrl.call(this, blob));
    };
  });

  const promotion = mobile.getByRole('button', { name: 'Create editor view' });
  await promotion.evaluate(element => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__promotionReadReleases.length)).toBe(2);
  await page.evaluate(() => {
    const releases = (window as any).__promotionReadReleases.splice(0);
    releases.forEach((release: () => void) => release());
  });
  await expect(mobile.getByText('Editor ready')).toBeVisible();
  await page.waitForTimeout(250);

  await mobile.getByRole('button', { name: 'Choose project' }).click();
  await page.getByLabel('Saved projects').getByRole('button', { name: 'Save current project' }).click();
  const promoted = await page.evaluate(async () => {
    const { StorageService } = await import(/* @vite-ignore */ ('/services/StorageService.ts' as string));
    const projectId = localStorage.getItem('signagepro_guest_project_id');
    const project = projectId ? await StorageService.loadProjectLocal(projectId) : null;
    const capture = project?.siteCaptures?.[0];
    return project && capture ? {
      canvasIds: project.canvases.map(canvas => canvas.id),
      promotedCanvasId: capture.promotedCanvasId,
    } : null;
  });
  expect(promoted?.canvasIds).toHaveLength(1);
  expect(promoted?.promotedCanvasId).toBe(promoted?.canvasIds[0]);
});

test('phone capture falls back when the bitmap decoder rejects a camera blob', async ({ page }, testInfo) => {
  test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'Camera blob compatibility is verified on phone profiles.');

  await page.addInitScript(() => {
    Object.defineProperty(window, 'createImageBitmap', {
      configurable: true,
      value: async () => { throw new DOMException('The blob could not be prepared for decoding', 'InvalidStateError'); },
    });
  });

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  const jpegBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 16;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f8fafc';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#0f172a';
    context.fillRect(4, 4, 16, 8);
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  });
  await mobile.locator('input[type=file]').setInputFiles({
    name: 'camera-photo.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(jpegBase64, 'base64'),
  });

  await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible();
  await mobile.getByRole('button', { name: 'Views' }).click();
  await expect(mobile.getByText('24 × 16')).toBeVisible();
  await expect(page.getByText('The blob could not be prepared for decoding')).toHaveCount(0);
});

test('phone dictation releases the microphone after completion and when the app becomes inactive', async ({ page }, testInfo) => {
  test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'Microphone lifecycle is verified on phone profiles.');

  await page.addInitScript(() => {
    (window as any).__dictationLifecycle = { starts: 0, stops: 0, aborts: 0 };
    class RecognitionLifecycleStub {
      continuous = false; interimResults = false; lang = 'en-US';
      onstart?: () => void; onend?: () => void; onresult?: (event: any) => void;
      start() { (window as any).__dictationLifecycle.starts += 1; this.onstart?.(); }
      stop() { (window as any).__dictationLifecycle.stops += 1; this.onend?.(); }
      abort() { (window as any).__dictationLifecycle.aborts += 1; this.onend?.(); }
      emitResult(text: string) { this.onresult?.({ results: [[{ transcript: text }]] }); }
    }
    (window as any).SpeechRecognition = RecognitionLifecycleStub;
    (window as any).webkitSpeechRecognition = RecognitionLifecycleStub;
    const Original = RecognitionLifecycleStub;
    (window as any).SpeechRecognition = class extends Original {
      constructor() { super(); (window as any).__activeRecognition = this; }
    };
    (window as any).webkitSpeechRecognition = (window as any).SpeechRecognition;
  });

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__dictationLifecycle.starts)).toBe(0);

  await mobile.getByRole('button', { name: 'Dictate project notes' }).click();
  await page.evaluate(() => (window as any).__activeRecognition.emitResult('Access is clear'));
  await expect.poll(() => page.evaluate(() => (window as any).__dictationLifecycle.stops)).toBe(1);

  await mobile.getByRole('button', { name: 'Dictate project notes' }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    (window as any).__activeRecognition.emitResult('This result arrived too late');
  });
  await expect.poll(() => page.evaluate(() => (window as any).__dictationLifecycle.aborts)).toBe(1);
  await expect(mobile.getByPlaceholder(/Access, power/)).toHaveValue('Access is clear');
});

test('recorded dictation discards audio when the app becomes inactive', async ({ page }, testInfo) => {
  test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'Recorded microphone cleanup is verified on phone profiles.');

  await page.addInitScript(() => {
    (window as any).__audioTracksStopped = 0;
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
    const track = { stop: () => { (window as any).__audioTracksStopped += 1; } };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
    (window as any).MediaRecorder = class {
      static isTypeSupported() { return true; }
      state = 'inactive'; mimeType = 'audio/webm';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: unknown, _options?: unknown) {}
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['private audio']) }); this.onstop?.(); }
    };
  });

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.getByRole('button', { name: 'Notes', exact: true }).click();
  await mobile.getByRole('button', { name: 'Dictate project notes' }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__audioTracksStopped)).toBeGreaterThan(0);
  await expect(mobile.getByPlaceholder(/Access, power/)).toHaveValue('');
});

test('delayed microphone permission is discarded after pagehide', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'The delayed-permission lifecycle is platform-independent and runs once on the iPhone profile.');

  await page.addInitScript(() => {
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
    (window as any).__delayedMic = { tracksStopped: 0, recorders: 0 };
    const track = { stop: () => { (window as any).__delayedMic.tracksStopped += 1; } };
    let grant: (() => void) | undefined;
    const stream = { getTracks: () => [track] };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => new Promise(resolve => { grant = () => resolve(stream); (window as any).__grantMic = grant; }) },
    });
    (window as any).MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { (window as any).__delayedMic.recorders += 1; }
    };
  });

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.getByRole('button', { name: 'Notes', exact: true }).click();
  await mobile.getByRole('button', { name: 'Dictate project notes' }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__grantMic)).toBe('function');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.evaluate(() => (window as any).__grantMic());

  await expect.poll(() => page.evaluate(() => (window as any).__delayedMic.tracksStopped)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__delayedMic.recorders)).toBe(0);
});

test('phone user adds supporting photos to an elevation and creates another elevation', async ({ page }, testInfo) => {
  test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'Multiple elevation capture is verified on phone profiles.');

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.locator('input[type=file]').setInputFiles({ name: 'front-primary.png', mimeType: 'image/png', buffer: PNG_1X1 });

  await mobile.getByRole('button', { name: 'Capture', exact: true }).click();
  await mobile.getByRole('button', { name: 'Add to this elevation' }).click();
  const sameElevationChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Take full-resolution photo' }).click();
  await (await sameElevationChooser).setFiles({ name: 'front-detail.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(mobile.getByText('2 photos')).toBeVisible();
  await expect(mobile.locator('article')).toHaveCount(1);

  await mobile.getByRole('button', { name: 'Open Elevation 1 photo 2' }).click();
  const photoViewer = page.getByRole('dialog', { name: 'Elevation 1 photo viewer' });
  await expect(photoViewer).toBeVisible();
  await expect(photoViewer.getByText('Photo 2 of 2')).toBeVisible();
  await expect(photoViewer.getByAltText('Elevation 1 photo 2 full view')).toBeVisible();
  await expect(photoViewer.getByRole('button', { name: 'Previous photo' })).toBeEnabled();
  await expect(photoViewer.getByRole('button', { name: 'Next photo' })).toBeDisabled();
  await photoViewer.getByRole('button', { name: 'Previous photo' }).click();
  await expect(photoViewer.getByText('Photo 1 of 2')).toBeVisible();
  await expect(photoViewer.getByAltText('Elevation 1 photo 1 full view')).toBeVisible();
  await photoViewer.getByRole('button', { name: 'Close photo viewer' }).click();
  await expect(photoViewer).toHaveCount(0);

  await mobile.getByRole('button', { name: 'Capture', exact: true }).click();
  await mobile.getByRole('button', { name: 'Add another elevation' }).click();
  const newElevationChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Take full-resolution photo' }).click();
  await (await newElevationChooser).setFiles({ name: 'side-primary.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible();
  await mobile.getByRole('button', { name: 'Views' }).click();
  await expect(mobile.locator('article')).toHaveCount(2);
  await expect(mobile.locator('input[value="Elevation 1"]')).toBeVisible();
  await expect(mobile.locator('input[value="Elevation 2"]')).toBeVisible();

  const firstElevation = mobile.locator('article').filter({ has: page.locator('input[value="Elevation 1"]') });
  await firstElevation.getByRole('button', { name: 'Add photo to Elevation 1' }).click();
  await mobile.locator('input[type=file]').setInputFiles({ name: 'front-closeup.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(firstElevation.getByText('3 photos')).toBeVisible();
});

test('in-flight photo processing cannot write into a different mobile project', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'The project-switch race is platform-independent and runs once on the iPhone profile.');

  await page.addInitScript(() => {
    let releasePersist: (() => void) | undefined;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ usage: 0, quota: 1024 * 1024 * 1024 }),
        persist: () => new Promise<boolean>(resolve => {
          releasePersist = () => resolve(true);
          (window as any).__releasePhotoProcessing = releasePersist;
        }),
      },
    });
  });

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();

  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.getByRole('button', { name: 'Choose project' }).click();
  const savedProjects = page.getByLabel('Saved projects');
  await savedProjects.getByLabel('Current project name').fill('First Site');
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();
  await savedProjects.getByRole('button', { name: 'New project' }).click();
  await mobile.getByRole('button', { name: 'Choose project' }).click();
  await savedProjects.getByLabel('Current project name').fill('Second Site');
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();
  await savedProjects.getByRole('button', { name: /Second Site/ }).click();

  await mobile.getByRole('button', { name: 'Open camera with level guide' }).click();
  const photoChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Take full-resolution photo' }).click();
  await (await photoChooser).setFiles({ name: 'second-site.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releasePhotoProcessing)).toBe('function');
  await mobile.getByRole('button', { name: 'Choose project' }).click();
  await savedProjects.getByRole('button', { name: /First Site/ }).click();
  await page.evaluate(() => (window as any).__releasePhotoProcessing());

  await expect(page.getByText('Photo discarded because the active project changed.')).toBeVisible();
  await mobile.getByRole('button', { name: 'Views' }).click();
  await expect(mobile.locator('article')).toHaveCount(0);
});

test('in-flight supporting photo is discarded when its elevation is deleted', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'The deleted-target race is platform-independent and runs once on the iPhone profile.');

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const mobile = page.getByTestId('mobile-site-capture');
  await mobile.locator('input[type=file]').setInputFiles({ name: 'front.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(mobile.getByRole('heading', { name: 'Reference wall' })).toBeVisible();
  await mobile.getByRole('button', { name: 'Views' }).click();
  await expect(mobile.getByRole('button', { name: 'Add photo to Elevation 1' })).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ usage: 0, quota: 1024 * 1024 * 1024 }),
        persist: () => new Promise<boolean>(resolve => {
          (window as any).__releaseSupportingPhoto = () => resolve(true);
        }),
      },
    });
  });

  await mobile.getByRole('button', { name: 'Add photo to Elevation 1' }).click();
  const supportingChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Take full-resolution photo' }).click();
  await (await supportingChooser).setFiles({ name: 'detail.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseSupportingPhoto)).toBe('function');
  page.once('dialog', dialog => dialog.accept());
  await mobile.getByRole('button', { name: 'Delete Elevation 1' }).click();
  await page.evaluate(() => (window as any).__releaseSupportingPhoto());

  await expect(page.getByText('Photo discarded because the selected elevation no longer exists.')).toBeVisible();
  await expect(mobile.locator('article')).toHaveCount(0);
});

test('phone user explicitly saves a named project and stays on the saved-project screen', async ({ page }, testInfo) => {
  test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'Mobile project saving is verified on phone profiles.');

  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Choose project' }).click();
  const savedProjects = page.getByLabel('Saved projects');
  await savedProjects.getByLabel('Current project name').fill('Riverside Survey');
  await savedProjects.getByRole('button', { name: 'Save current project' }).click();

  await expect(savedProjects).toBeVisible();
  await expect(savedProjects.getByTestId('current-saved-project')).toContainText('Riverside Survey');
  await expect(savedProjects.getByText('Projects on this device')).toBeVisible();
  await expect(savedProjects.getByLabel('Current project name')).not.toBeFocused();

  const storedName = await page.evaluate(async () => {
    const projectId = localStorage.getItem('signagepro_guest_project_id');
    const request = indexedDB.open('SignageProDB', 4);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('projects', 'readonly');
    const get = tx.objectStore('projects').get(projectId!);
    const project = await new Promise<any>((resolve, reject) => { get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    return project?.projectName;
  });
  expect(storedName).toBe('Riverside Survey');
});
