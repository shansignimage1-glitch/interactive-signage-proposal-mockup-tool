import { expect, test } from '@playwright/test';

const IPAD_PROJECTS = ['ipad', 'ipad-webkit'];

// Regression: ISSUE-IPAD-001 — compact Safari chrome routed iPad to the phone capture shell
// Found by /qa on 2026-08-13
// Report: .gstack/qa-reports/qa-report-ipad-routing-2026-08-13.md
test('iPad with a compact landscape viewport stays in the tablet editor', async ({ page }, testInfo) => {
  test.skip(!IPAD_PROJECTS.includes(testInfo.project.name), 'The routing regression is specific to iPad browser profiles.');

  // Safari toolbars and the sidebar can reduce a landscape iPad's content
  // viewport below 700px high even though the physical screen is tablet-sized.
  await page.setViewportSize({ width: 1024, height: 650 });
  await page.goto('/');

  const display = await page.evaluate(() => ({
    compactCoarseViewport: window.matchMedia('(max-height: 699px) and (pointer: coarse)').matches,
    screen: { width: window.screen.width, height: window.screen.height },
  }));
  expect(display.compactCoarseViewport).toBe(true);
  expect(Math.min(display.screen.width, display.screen.height)).toBeGreaterThanOrEqual(600);

  await page.getByRole('button', { name: 'Continue as Guest' }).click();

  await expect(page.getByTestId('controls-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download PDF/PNG to device' })).toBeVisible();
  await expect(page.getByTestId('mobile-site-capture')).toHaveCount(0);
});

test('explicit mobile capture remains available on iPad', async ({ page }, testInfo) => {
  test.skip(!IPAD_PROJECTS.includes(testInfo.project.name), 'The override is checked on iPad browser profiles.');

  await page.setViewportSize({ width: 1024, height: 650 });
  await page.goto('/?mobileCapture=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();

  await expect(page.getByTestId('mobile-site-capture')).toBeVisible();
  await expect(page.getByTestId('mobile-tool-dock')).toHaveCount(0);

  await page.evaluate(() => { window.location.hash = '/privacy'; });
  await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL(/\?mobileCapture=1$/);
  await expect(page.getByTestId('mobile-site-capture')).toBeVisible();
});
