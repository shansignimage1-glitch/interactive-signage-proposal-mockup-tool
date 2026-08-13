import { expect, test } from '@playwright/test';

const PHONE_PROJECTS = ['iphone', 'iphone-webkit', 'android-phone'];

// Regression: ISSUE-IPAD-001 — separating tablets from phones must preserve automatic phone capture
// Found by /qa on 2026-08-13
// Report: .gstack/qa-reports/qa-report-ipad-routing-2026-08-13.md
test('phones automatically open capture and can explicitly open the editor', async ({ page }, testInfo) => {
  test.skip(!PHONE_PROJECTS.includes(testInfo.project.name), 'Automatic phone routing is verified on phone profiles.');

  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByTestId('mobile-site-capture')).toBeVisible();

  await page.goto('/?editor=1');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByTestId('mobile-site-capture')).toHaveCount(0);
  await expect(page.getByTestId('mobile-tool-dock')).toBeVisible();
});
