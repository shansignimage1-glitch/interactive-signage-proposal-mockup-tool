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

test('iPad keeps its left controls menu when the Safari sidebar narrows the page', async ({ page }, testInfo) => {
  test.skip(!IPAD_PROJECTS.includes(testInfo.project.name), 'The compact tablet layout is checked on iPad browser profiles.');

  await page.setViewportSize({ width: 700, height: 650 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();

  const panel = page.getByTestId('controls-panel');
  await expect(panel).toHaveAttribute('data-layout', 'tablet-side-panel');
  await expect(page.getByTestId('mobile-tool-dock')).toHaveCount(0);
  const layout = await panel.evaluate(element => ({
    position: getComputedStyle(element).position,
    width: element.getBoundingClientRect().width,
    x: element.getBoundingClientRect().x,
    height: element.getBoundingClientRect().height,
  }));
  expect(layout.position).toBe('static');
  expect(layout.x).toBe(0);
  expect(layout.width).toBe(320);
  expect(layout.height).toBe(650);
  await expect(page.getByText('Dimensions', { exact: true })).toBeVisible();
});

test('iPad Split View uses compact controls when a side panel would consume the canvas', async ({ page }, testInfo) => {
  test.skip(!IPAD_PROJECTS.includes(testInfo.project.name), 'The compact tablet layout is checked on iPad browser profiles.');

  await page.setViewportSize({ width: 500, height: 650 });
  await page.addInitScript(() => {
    Object.defineProperty(window.screen, 'width', { configurable: true, get: () => 1194 });
    Object.defineProperty(window.screen, 'height', { configurable: true, get: () => 834 });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();

  await expect(page.getByTestId('controls-panel')).toHaveAttribute('data-layout', 'responsive');
  await expect(page.getByTestId('mobile-tool-dock')).toBeVisible();
  const canvas = page.locator('canvas').first();
  const canvasBounds = await canvas.boundingBox();
  expect(canvasBounds).not.toBeNull();
  expect(canvasBounds!.width).toBeGreaterThanOrEqual(400);
});

test('idle iPad login never invents a sign-in timeout', async ({ page }, testInfo) => {
  test.skip(!IPAD_PROJECTS.includes(testInfo.project.name), 'The former watchdog regression affected iPad auth.');

  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await page.clock.fastForward(13_000);
  await expect(page.getByText('Sign-in took too long to finish. Please try again.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
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
