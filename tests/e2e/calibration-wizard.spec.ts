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

test('adds a measurable wall 500mm behind a confirmed reference plane', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Offset-plane workflow runs once on desktop Chromium.');
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: /Set real-world scale/ }).click();
  await page.getByRole('button', { name: /Angled facade/ }).click();

  const surface = page.locator('#export-target');
  const bounds = await surface.boundingBox();
  expect(bounds).not.toBeNull();
  const reference = [
    { x: bounds!.width * 0.2, y: bounds!.height * 0.2 },
    { x: bounds!.width * 0.72, y: bounds!.height * 0.24 },
    { x: bounds!.width * 0.68, y: bounds!.height * 0.72 },
    { x: bounds!.width * 0.24, y: bounds!.height * 0.68 },
  ];
  for (const position of reference) await surface.click({ position });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Review calibration' }).click();
  await page.getByRole('button', { name: 'Apply calibration' }).click();

  await page.getByRole('button', { name: '+ Plane', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add measurement plane' })).toBeVisible();
  await page.getByRole('button', { name: /Parallel offset plane/ }).click();
  const offsetPlane = [
    { x: bounds!.width * 0.33, y: bounds!.height * 0.3 },
    { x: bounds!.width * 0.62, y: bounds!.height * 0.32 },
    { x: bounds!.width * 0.6, y: bounds!.height * 0.62 },
    { x: bounds!.width * 0.35, y: bounds!.height * 0.6 },
  ];
  for (const position of offsetPlane) await surface.click({ position });
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Define the plane relationship' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Reference plane' })).toHaveValue(/plane-/);
  await expect(page.getByRole('spinbutton', { name: 'Plane offset distance' })).toHaveValue('500');
  await expect(page.getByRole('combobox', { name: 'Plane offset direction' })).toHaveValue('behind');
  await expect(page.getByText(/Estimated camera model/)).toBeVisible();
  await page.getByRole('button', { name: 'Review calibration' }).click();
  await expect(page.getByText(/Derived plane/)).toBeVisible();
  await page.getByRole('button', { name: 'Add calibrated plane' }).click();

  const planeSelect = page.getByRole('combobox', { name: 'Active calibrated plane' });
  await expect(planeSelect.locator('option')).toHaveCount(2);
  await expect(page.getByText(/Parallel offset · 500mm behind · estimated camera/)).toBeVisible();

  await page.getByRole('button', { name: 'Measure line' }).click();
  await surface.click({ position: offsetPlane[0] });
  await surface.click({ position: offsetPlane[1] });
  const measuredLabel = page.locator('#export-target input').last();
  await expect(measuredLabel).toHaveValue(/(mm|cm|m)$/);
  await expect(measuredLabel).not.toHaveValue('...');
});
