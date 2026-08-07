import { expect, test, type Page } from '@playwright/test';

const dispatchTouch = async (
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pointerId: number,
  x: number,
  y: number,
) => {
  await page.locator('#export-target').evaluate((element, event) => {
    element.dispatchEvent(new PointerEvent(event.type, {
      bubbles: true,
      cancelable: true,
      pointerId: event.pointerId,
      pointerType: 'touch',
      isPrimary: event.pointerId === 1,
      clientX: event.x,
      clientY: event.y,
      button: 0,
      buttons: event.type === 'pointerup' ? 0 : 1,
    }));
  }, { type, pointerId, x, y });
};

const transform = (page: Page) => page.locator('#export-target').evaluate(element => {
  const matrix = new DOMMatrix(getComputedStyle(element).transform);
  return { x: matrix.m41, y: matrix.m42, scale: matrix.a };
});

test('touch gestures pan and pinch the canvas without changing project coordinates', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByRole('button', { name: 'Pan' })).toBeVisible();

  // Synthetic PointerEvents are sufficient for gesture routing; pointer
  // capture itself is browser-owned and cannot be activated by synthetic input.
  await page.evaluate(() => {
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
    Element.prototype.hasPointerCapture = () => false;
  });

  const surface = page.locator('#export-target');
  const bounds = await surface.boundingBox();
  expect(bounds).not.toBeNull();
  const center = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };

  await page.getByRole('button', { name: 'Pan' }).click();
  const beforePan = await transform(page);
  await dispatchTouch(page, 'pointerdown', 1, center.x, center.y);
  await dispatchTouch(page, 'pointermove', 1, center.x + 90, center.y + 55);
  await dispatchTouch(page, 'pointerup', 1, center.x + 90, center.y + 55);
  await page.waitForTimeout(50);
  const afterPan = await transform(page);
  expect(afterPan.x - beforePan.x).toBeCloseTo(90, 0);
  expect(afterPan.y - beforePan.y).toBeCloseTo(55, 0);

  await page.getByRole('button', { name: 'Fit canvas to screen' }).click();
  await page.getByRole('button', { name: 'Select' }).click();
  const beforeEmptyPan = await transform(page);
  await dispatchTouch(page, 'pointerdown', 1, bounds!.x + 20, bounds!.y + 20);
  await dispatchTouch(page, 'pointermove', 1, bounds!.x + 65, bounds!.y + 50);
  await dispatchTouch(page, 'pointerup', 1, bounds!.x + 65, bounds!.y + 50);
  await page.waitForTimeout(50);
  const afterEmptyPan = await transform(page);
  expect(afterEmptyPan.x - beforeEmptyPan.x).toBeCloseTo(45, 0);
  expect(afterEmptyPan.y - beforeEmptyPan.y).toBeCloseTo(30, 0);

  await page.getByRole('button', { name: 'Fit canvas to screen' }).click();
  const beforePinch = await transform(page);
  await dispatchTouch(page, 'pointerdown', 1, center.x - 50, center.y);
  await dispatchTouch(page, 'pointerdown', 2, center.x + 50, center.y);
  await dispatchTouch(page, 'pointermove', 1, center.x - 100, center.y + 20);
  await dispatchTouch(page, 'pointermove', 2, center.x + 100, center.y + 20);
  await dispatchTouch(page, 'pointerup', 1, center.x - 100, center.y + 20);
  await dispatchTouch(page, 'pointerup', 2, center.x + 100, center.y + 20);
  await page.waitForTimeout(50);
  const afterPinch = await transform(page);
  expect(afterPinch.scale).toBeGreaterThan(beforePinch.scale * 1.8);
  expect(afterPinch.y).toBeGreaterThan(beforePinch.y);
});
