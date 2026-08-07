import { expect, test } from '@playwright/test';
import path from 'node:path';

const fixture = path.resolve('tests/fixtures/facade.svg');

test('guest can upload, autosave, reopen, browse library, measure, and export', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();

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
  await expect(page.getByText('Guest User')).toBeVisible();

  await page.getByRole('button', { name: 'Lib', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Asset Library' })).toBeVisible();
  await page.getByRole('button', { name: 'Close asset library' }).click();

  await page.getByRole('button', { name: 'Scale' }).click();
  await expect(page.getByRole('button', { name: 'Scale' })).toHaveClass(/bg-amber-600/);
  const drawingSurface = page.locator('#export-target');
  const bounds = await drawingSurface.boundingBox();
  expect(bounds).not.toBeNull();
  await drawingSurface.click({ position: { x: bounds!.width * 0.35, y: bounds!.height * 0.4 } });
  await drawingSurface.click({ position: { x: bounds!.width * 0.55, y: bounds!.height * 0.4 } });
  await expect(page.getByRole('heading', { name: 'Set Real-World Scale' })).toBeVisible();
  await page.getByRole('button', { name: 'Set Scale' }).click();
  await expect(page.getByText(/1px ≈/)).toBeVisible();

  await page.getByRole('button', { name: 'Line' }).click();
  await expect(page.getByRole('button', { name: 'Line' })).toHaveClass(/bg-blue-600/);
  await drawingSurface.click({ position: { x: bounds!.width * 0.3, y: bounds!.height * 0.55 } });
  await drawingSurface.click({ position: { x: bounds!.width * 0.6, y: bounds!.height * 0.55 } });
  await expect(page.locator('#export-target input')).toHaveValue(/(mm|cm|m)$/);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF/PNG to device' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});
