import { expect, test } from '@playwright/test';
import path from 'node:path';

const fixture = path.resolve('tests/fixtures/facade.svg');

test('guest can upload, autosave, reopen, browse library, measure, and export', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();

  const openMobileControls = async () => {
    const button = page.getByRole('button', { name: 'Open all controls' });
    if (await button.isVisible()) await button.click();
  };

  await openMobileControls();
  await page.getByRole('button', { name: /New Image \/ Camera/ }).click();
  await expect(page.getByText('Select Image Source')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.getByText('Crop & Convert')).toBeVisible();
  await page.getByRole('button', { name: 'Crop & Save PNG' }).click();
  await expect(page.getByText('Select Image Source')).toBeHidden();

  // Autosave writes the complete project to IndexedDB after a 3-second debounce.
  await page.waitForTimeout(3_500);
  const projectId = await page.evaluate(() => localStorage.getItem('signagepro_guest_project_id'));
  const storedBackground = await page.evaluate(async id => {
    const request = indexedDB.open('SignageProDB', 4);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('projects', 'readonly');
    const get = tx.objectStore('projects').get(id!);
    const project = await new Promise<any>((resolve, reject) => {
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    return project?.canvases?.[0]?.backgroundImage;
  }, projectId);
  expect(storedBackground).toMatch(/^data:image\/png;base64,/);

  await page.reload();
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();

  await openMobileControls();
  await page.getByRole('button', { name: 'Lib', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Asset Library' })).toBeVisible();
  await page.getByRole('button', { name: 'Close asset library' }).click();

  await page.getByRole('button', { name: /Set real-world scale/ }).click();
  await expect(page.getByRole('heading', { name: 'How was this photo taken?' })).toBeVisible();
  await page.getByRole('button', { name: /Straight-on photo/ }).click();
  const drawingSurface = page.locator('#export-target');
  const bounds = await drawingSurface.boundingBox();
  expect(bounds).not.toBeNull();
  await drawingSurface.click({ position: { x: bounds!.width * 0.35, y: bounds!.height * 0.4 } });
  await drawingSurface.click({ position: { x: bounds!.width * 0.55, y: bounds!.height * 0.4 } });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Enter the known size' })).toBeVisible();
  await page.getByRole('button', { name: 'Review calibration' }).click();
  await expect(page.getByRole('heading', { name: 'Review calibration' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply calibration' }).click();
  const mobileCalibration = page.getByRole('button', { name: 'Edit calibration' });
  if (await mobileCalibration.isVisible()) await expect(mobileCalibration).toBeVisible();
  else await expect(page.locator('p').filter({ hasText: /^Calibrated$/ })).toBeVisible();

  await page.getByRole('button', { name: 'Measure line' }).click();
  await expect(page.getByRole('button', { name: 'Measure line' })).toHaveClass(/bg-blue-600/);
  await drawingSurface.click({ position: { x: bounds!.width * 0.3, y: bounds!.height * 0.55 } });
  await drawingSurface.click({ position: { x: bounds!.width * 0.6, y: bounds!.height * 0.55 } });
  await expect(page.locator('#export-target input')).toHaveValue(/(mm|cm|m)$/);

  await openMobileControls();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF/PNG to device' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});
