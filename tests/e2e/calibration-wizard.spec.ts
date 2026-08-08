import { expect, test } from '@playwright/test';

test('perspective calibration keeps four large points editable before apply', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: /Set real-world scale/ }).click();
  await page.getByRole('button', { name: /Angled facade/ }).click();

  const surface = page.locator('#export-target');
  const bounds = await surface.boundingBox();
  expect(bounds).not.toBeNull();
  const positions = [
    { x: bounds!.width * 0.25, y: bounds!.height * 0.28 },
    { x: bounds!.width * 0.68, y: bounds!.height * 0.31 },
    { x: bounds!.width * 0.63, y: bounds!.height * 0.66 },
    { x: bounds!.width * 0.3, y: bounds!.height * 0.63 },
  ];
  for (const position of positions) await surface.click({ position });

  const handles = page.locator('[data-calibration-handle]');
  await expect(handles).toHaveCount(4);
  const firstHandle = handles.first();
  const before = await firstHandle.boundingBox();
  expect(before).not.toBeNull();
  expect(before!.width).toBeGreaterThanOrEqual(44);
  expect(before!.height).toBeGreaterThanOrEqual(44);

  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 + 18, before!.y + before!.height / 2 + 10);
  await page.mouse.up();
  await expect.poll(async () => (await firstHandle.boundingBox())!.x).toBeGreaterThan(before!.x + 10);

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Enter the known size' })).toBeVisible();
  await page.getByRole('button', { name: 'Review calibration' }).click();
  await page.getByRole('button', { name: 'Apply calibration' }).click();
  const mobileCalibration = page.getByRole('button', { name: 'Edit calibration' });
  if (await mobileCalibration.isVisible()) await expect(mobileCalibration).toBeVisible();
  else await expect(page.getByText(/Perspective wall/)).toBeVisible();
});
