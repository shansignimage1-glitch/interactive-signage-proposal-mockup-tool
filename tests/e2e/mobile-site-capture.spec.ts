import { expect, test } from '@playwright/test';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const PHONE_PROJECTS = ['iphone', 'iphone-webkit', 'android-phone'];

test('phone mode captures an original, records wall geometry, dictates notes, and creates an editor view', async ({ page }, testInfo) => {
  test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'Dedicated phone workflow is verified on iPhone and Android profiles.');

  await page.addInitScript(() => {
    class RecognitionStub {
      continuous = false; interimResults = false; lang = 'en-US';
      onstart?: () => void; onend?: () => void; onresult?: (event: any) => void;
      start() {
        this.onstart?.();
        this.onresult?.({ results: [[{ transcript: 'Power supply is above the entrance' }]] });
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
