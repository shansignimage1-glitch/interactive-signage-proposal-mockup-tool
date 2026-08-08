import { expect, test } from '@playwright/test';

test('login entry point is available and guest identity survives reload', async ({ page }) => {
  await page.goto('/');
  const google = page.getByRole('button', { name: 'Sign in with Google' });
  await expect(google).toBeVisible();
  await expect(google).toBeEnabled();

  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();
  const firstProjectId = await page.evaluate(() => localStorage.getItem('signagepro_guest_project_id'));
  expect(firstProjectId).toBeTruthy();

  await page.waitForTimeout(3_500);
  await page.reload();
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByRole('button', { name: 'Sign Out' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('signagepro_guest_project_id'))).toBe(firstProjectId);
});

test('layout remains usable at the configured device viewport', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const viewport = page.viewportSize();
  if (testInfo.project.name === 'iphone' || testInfo.project.name === 'ipad') {
    if (testInfo.project.name === 'iphone') {
      expect(viewport?.width).toBe(390);
      expect(viewport?.height).toBe(664);
    } else {
      expect(viewport?.width).toBe(834);
      expect(viewport?.height).toBe(1194);
    }
    const dock = page.getByTestId('mobile-tool-dock');
    await expect(dock).toBeVisible();
    expect((await dock.boundingBox())!.height).toBeLessThanOrEqual(90);
    await expect(page.getByRole('button', { name: 'Open all controls' })).toBeVisible();
    await page.getByRole('button', { name: 'Open all controls' }).click();
    await expect(page.getByRole('button', { name: 'Download PDF/PNG to device' })).toBeVisible();
    await expect(page.getByText('Dimensions', { exact: true })).toBeVisible();
    await expect(page.getByTestId('controls-panel')).toHaveAttribute('data-mobile-expanded', 'true');
    return;
  }
  expect(viewport?.width).toBeGreaterThan(700);
  await expect(page.getByRole('button', { name: 'Download PDF/PNG to device' })).toBeVisible();
  await expect(page.getByText('Dimensions', { exact: true })).toBeVisible();
});
