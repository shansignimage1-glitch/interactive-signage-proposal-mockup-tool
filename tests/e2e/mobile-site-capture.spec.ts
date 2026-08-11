import { expect, test } from '@playwright/test';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('phone mode captures an original, records wall geometry, dictates notes, and creates an editor view', async ({ page }, testInfo) => {
  test.skip(!['iphone', 'android-phone'].includes(testInfo.project.name), 'Dedicated phone workflow is verified on iPhone and Android profiles.');

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
    return { original: assets.find(asset => String(asset.ref).endsWith('/original'))?.blob?.size ?? 0, count: assets.length };
  });
  expect(stored.original).toBe(PNG_1X1.length);
  expect(stored.count).toBeGreaterThanOrEqual(3);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByTestId('mobile-site-capture')).toBeVisible();
});
