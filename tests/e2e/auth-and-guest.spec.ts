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
  const isPhone = testInfo.project.name.startsWith('iphone');
  const isTablet = testInfo.project.name.startsWith('ipad');
  if (isPhone || isTablet) {
    if (isPhone) {
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
    if (isTablet) {
      for (const name of ['Sign Out', 'Zoom in', 'Zoom out', 'Fit canvas to screen', 'Lock canvas view', 'Open 3D proposal viewer']) {
        const bounds = await page.getByRole('button', { name }).boundingBox();
        expect(bounds, `${name} should have a tablet-sized touch target`).not.toBeNull();
        expect(bounds!.width, `${name} target width`).toBeGreaterThanOrEqual(44);
        expect(bounds!.height, `${name} target height`).toBeGreaterThanOrEqual(44);
      }
    }
    return;
  }
  expect(viewport?.width).toBeGreaterThan(700);
  await expect(page.getByRole('button', { name: 'Download PDF/PNG to device' })).toBeVisible();
  await expect(page.getByText('Dimensions', { exact: true })).toBeVisible();
});

test('desktop editor controls remain clear of the legal footer and show keyboard focus', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop layout and keyboard-focus coverage.');

  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();

  const viewName = page.getByPlaceholder('View Name');
  await viewName.focus();
  const focusStyle = await viewName.evaluate(element => ({
    outline: getComputedStyle(element).outlineStyle,
    shadow: getComputedStyle(element).boxShadow,
  }));
  expect(focusStyle.outline !== 'none' || focusStyle.shadow !== 'none').toBeTruthy();

  const download = page.getByRole('button', { name: 'Download PDF/PNG to device' });
  const privacy = page.getByRole('link', { name: 'Privacy' });
  const downloadBox = await download.boundingBox();
  const privacyBox = await privacy.boundingBox();
  expect(downloadBox).not.toBeNull();
  expect(privacyBox).not.toBeNull();
  expect(downloadBox!.y + downloadBox!.height).toBeLessThanOrEqual(privacyBox!.y);
});
