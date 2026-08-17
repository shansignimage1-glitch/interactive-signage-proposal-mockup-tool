import { expect, test, type Page } from '@playwright/test';

// Regression: ISSUE-PROJECTION-001 — direction had no accessible control name,
// and the direction/depth/backing interactions were not covered end to end.
// Found by /qa on 2026-08-17.

const addPlaceholderSign = async (page: Page) => {
  const openAllControls = page.getByRole('button', { name: 'Open all controls' });
  if (await openAllControls.isVisible()) await openAllControls.click();
  const signsHeader = page.getByTestId('controls-panel').getByRole('heading', { name: 'Signs' }).locator('..');
  await signsHeader.getByRole('button').last().click();
  await expect(page.locator('[data-testid^="sign-hit-area-"]')).toHaveCount(1);
};

const renderedBounds = (page: Page) => page.locator('#export-target canvas.pointer-events-none').evaluate(canvasElement => {
  const canvas = canvasElement as HTMLCanvasElement;
  const gl = canvas.getContext('webgl');
  if (!gl) return null;
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let minX = canvas.width;
  let maxX = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (pixels[(y * canvas.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  if (maxX < minX) return null;
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / canvas.width;
  return { left: rect.left + minX * scale, right: rect.left + (maxX + 1) * scale, width: (maxX - minX + 1) * scale };
});

test('projection direction, visual depth, and backing depth work together', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await addPlaceholderSign(page);

  const construction = page.getByRole('combobox', { name: 'Sign extrusion construction' });
  const visualDepth = page.getByRole('slider', { name: 'Letter and logo extrusion depth' });
  const backingDepth = page.getByRole('slider', { name: 'Backing board extrusion depth' });
  const direction = page.getByRole('slider', { name: 'Extrusion direction' });

  await expect(construction).toHaveValue('backed');
  await expect(direction).toBeVisible();
  await expect(page.getByTestId('extrusion-detection-status')).toBeHidden({ timeout: 15_000 });

  await construction.selectOption('individual');
  await visualDepth.fill('1');
  await direction.fill('0');
  await page.waitForTimeout(100);
  const shallow = await renderedBounds(page);
  expect(shallow).not.toBeNull();

  await visualDepth.fill('60');
  await expect.poll(async () => (await renderedBounds(page))?.width ?? 0).toBeGreaterThan(shallow!.width + 5);
  const leftward = await renderedBounds(page);
  expect(leftward).not.toBeNull();

  await direction.fill('180');
  await expect.poll(async () => (await renderedBounds(page))?.right ?? 0).toBeGreaterThan(leftward!.right + 5);
  const rightward = await renderedBounds(page);
  expect(rightward).not.toBeNull();
  expect(rightward!.left).toBeGreaterThan(leftward!.left + 5);

  await construction.selectOption('backed');
  await visualDepth.fill('40');
  await backingDepth.fill('12');
  await expect(backingDepth).toHaveValue('12');
  await construction.selectOption('individual');
  await expect(backingDepth).toBeHidden();
  await construction.selectOption('backed');
  await expect(backingDepth).toHaveValue('12');

  await visualDepth.fill('10');
  await expect(backingDepth).toHaveValue('8');
  expect(Number(await backingDepth.getAttribute('max'))).toBe(8);
});
