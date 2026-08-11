import { expect, test } from '@playwright/test';

test('opens the optional 3D proposal and keeps missing elevations explicit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Open 3D proposal viewer' }).click();

  const viewer = page.getByTestId('proposal-3d-viewer');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('heading', { name: '3D Proposal Viewer' })).toBeVisible();
  await expect(viewer.getByLabel('Rotatable 3D building proposal').locator('canvas')).toBeVisible();
  await expect(viewer.getByText('Not surveyed', { exact: true })).toHaveCount(4);
  await expect(viewer.getByText('Accuracy rule')).toBeVisible();

  await viewer.getByRole('button', { name: 'Close 3D proposal viewer' }).click();
  await expect(viewer).toBeHidden();
});

