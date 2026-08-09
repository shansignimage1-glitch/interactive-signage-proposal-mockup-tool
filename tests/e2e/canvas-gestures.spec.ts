import { expect, test, type Page } from '@playwright/test';

const dispatchTouch = async (
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pointerId: number,
  x: number,
  y: number,
  target = '#export-target',
) => {
  await page.locator(target).first().evaluate((element, event) => {
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

const calibrateCanvas = async (page: Page) => {
  const openAllControls = page.getByRole('button', { name: 'Open all controls' });
  if (await openAllControls.isVisible()) await openAllControls.click();

  await page.getByRole('button', { name: /Set real-world scale/ }).click();
  await page.getByRole('button', { name: /Straight-on photo/ }).click();
  const surface = page.locator('#export-target');
  const bounds = await surface.boundingBox();
  expect(bounds).not.toBeNull();
  await surface.click({ position: { x: bounds!.width * 0.32, y: bounds!.height * 0.38 } });
  await surface.click({ position: { x: bounds!.width * 0.56, y: bounds!.height * 0.38 } });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Review calibration' }).click();
  await page.getByRole('button', { name: 'Apply calibration' }).click();
};

test('touch drawing and dimension resize handles show a finger-offset precision magnifier', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop-chromium', 'Touch precision UI is specific to iPad and phone layouts.');

  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.evaluate(() => {
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
    Element.prototype.hasPointerCapture = () => false;
  });
  await calibrateCanvas(page);

  const surface = page.locator('#export-target');
  const bounds = await surface.boundingBox();
  expect(bounds).not.toBeNull();
  const signBounds = await page.locator('[data-testid^="sign-hit-area-"]').first().boundingBox();
  expect(signBounds).not.toBeNull();
  const lineStart = { x: signBounds!.x + signBounds!.width / 2, y: signBounds!.y + signBounds!.height / 2 };
  const lineEnd = { x: Math.min(bounds!.x + bounds!.width * 0.82, lineStart.x + bounds!.width * 0.28), y: lineStart.y };

  await page.getByRole('button', { name: 'Measure line' }).click();
  await dispatchTouch(page, 'pointerdown', 1, lineStart.x, lineStart.y);
  const loupe = page.getByTestId('precision-loupe');
  await expect(loupe).toBeVisible();
  await expect(loupe).toHaveAttribute('data-loupe-kind', 'drawing');
  const signLayer = page.getByTestId('precision-loupe-sign-layer');
  await expect(signLayer).toBeVisible();
  await expect.poll(async () => signLayer.evaluate(node => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visiblePixels = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) visiblePixels += 1;
    return visiblePixels;
  })).toBeGreaterThan(0);
  const firstLoupeBounds = await loupe.boundingBox();
  expect(firstLoupeBounds).not.toBeNull();
  expect(
    lineStart.x >= firstLoupeBounds!.x && lineStart.x <= firstLoupeBounds!.x + firstLoupeBounds!.width &&
    lineStart.y >= firstLoupeBounds!.y && lineStart.y <= firstLoupeBounds!.y + firstLoupeBounds!.height,
  ).toBe(false);

  await dispatchTouch(page, 'pointermove', 1, lineEnd.x, lineEnd.y);
  await dispatchTouch(page, 'pointerup', 1, lineEnd.x, lineEnd.y);
  await expect(loupe).toBeHidden();
  await expect(page.locator('#export-target input')).toHaveCount(1);

  const lineHandle = page.locator('[data-dimension-handle="0"]').first();
  await expect(lineHandle).toBeVisible();
  const lineHandleBounds = await lineHandle.boundingBox();
  expect(lineHandleBounds).not.toBeNull();
  const lineHandleCenter = {
    x: lineHandleBounds!.x + lineHandleBounds!.width / 2,
    y: lineHandleBounds!.y + lineHandleBounds!.height / 2,
  };
  await dispatchTouch(page, 'pointerdown', 1, lineHandleCenter.x, lineHandleCenter.y, '[data-dimension-handle="0"]');
  await expect(loupe).toHaveAttribute('data-loupe-kind', 'dimension');
  await dispatchTouch(page, 'pointermove', 1, lineHandleCenter.x + 18, lineHandleCenter.y + 10, '[data-dimension-handle="0"]');
  await dispatchTouch(page, 'pointerup', 1, lineHandleCenter.x + 34, lineHandleCenter.y + 22, '[data-dimension-handle="0"]');
  await expect(loupe).toBeHidden();
  await expect.poll(async () => (await lineHandle.boundingBox())!.x).toBeGreaterThan(lineHandleBounds!.x + 25);

  const openAllControls = page.getByRole('button', { name: 'Open all controls' });
  if (await openAllControls.isVisible()) await openAllControls.click();
  await page.getByRole('button', { name: 'Width × height' }).click();
  const boxStart = { x: bounds!.x + bounds!.width * 0.36, y: bounds!.y + bounds!.height * 0.42 };
  const boxEnd = { x: bounds!.x + bounds!.width * 0.68, y: bounds!.y + bounds!.height * 0.7 };
  await dispatchTouch(page, 'pointerdown', 1, boxStart.x, boxStart.y);
  await expect(loupe).toHaveAttribute('data-loupe-kind', 'drawing');
  await dispatchTouch(page, 'pointerup', 1, boxStart.x, boxStart.y);
  await expect(page.locator('#export-target input')).toHaveCount(1);
  await dispatchTouch(page, 'pointerdown', 1, boxEnd.x - 18, boxEnd.y - 14);
  await expect(loupe).toHaveAttribute('data-loupe-kind', 'drawing');
  await dispatchTouch(page, 'pointermove', 1, boxEnd.x, boxEnd.y);
  await dispatchTouch(page, 'pointerup', 1, boxEnd.x, boxEnd.y);
  await expect(page.locator('#export-target input')).toHaveCount(2);

  const boxHandle = page.locator('[data-dimension-handle="10"]');
  await expect(boxHandle).toBeVisible();
  const boxHandleBounds = await boxHandle.boundingBox();
  expect(boxHandleBounds).not.toBeNull();
  await dispatchTouch(
    page,
    'pointerdown',
    1,
    boxHandleBounds!.x + boxHandleBounds!.width / 2,
    boxHandleBounds!.y + boxHandleBounds!.height / 2,
    '[data-dimension-handle="10"]',
  );
  await expect(loupe).toHaveAttribute('data-loupe-kind', 'dimension');
  await dispatchTouch(
    page,
    'pointerup',
    1,
    boxHandleBounds!.x + boxHandleBounds!.width / 2,
    boxHandleBounds!.y + boxHandleBounds!.height / 2,
    '[data-dimension-handle="10"]',
  );
  await expect(loupe).toBeHidden();

  await page.getByRole('button', { name: 'Lock canvas view' }).click();
  const reopenAllControls = page.getByRole('button', { name: 'Open all controls' });
  if (await reopenAllControls.isVisible()) await reopenAllControls.click();
  await page.getByRole('button', { name: 'Measure line' }).click();
  const lockedStart = { x: bounds!.x + bounds!.width * 0.24, y: bounds!.y + bounds!.height * 0.78 };
  await dispatchTouch(page, 'pointerdown', 1, lockedStart.x, lockedStart.y);
  await expect(loupe).toBeVisible();
  await dispatchTouch(page, 'pointerdown', 2, lockedStart.x + 90, lockedStart.y);
  await expect(loupe).toBeHidden();
  await dispatchTouch(page, 'pointermove', 1, lockedStart.x - 30, lockedStart.y + 20);
  await dispatchTouch(page, 'pointermove', 2, lockedStart.x + 130, lockedStart.y + 20);
  await dispatchTouch(page, 'pointerup', 2, lockedStart.x + 130, lockedStart.y + 20);
  await dispatchTouch(page, 'pointerup', 1, lockedStart.x - 30, lockedStart.y + 20);
  await expect(page.locator('#export-target input')).toHaveCount(2);
});

test('touch gestures pan and pinch the canvas without changing project coordinates', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await expect(page.getByRole('button', { name: 'Pan view' })).toBeVisible();

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

  await page.getByRole('button', { name: 'Pan view' }).click();
  const beforePan = await transform(page);
  await dispatchTouch(page, 'pointerdown', 1, center.x, center.y);
  await dispatchTouch(page, 'pointermove', 1, center.x + 90, center.y + 55);
  await dispatchTouch(page, 'pointerup', 1, center.x + 90, center.y + 55);
  await page.waitForTimeout(50);
  const afterPan = await transform(page);
  expect(afterPan.x - beforePan.x).toBeCloseTo(90, 0);
  expect(afterPan.y - beforePan.y).toBeCloseTo(55, 0);

  await page.getByRole('button', { name: 'Fit canvas to screen' }).click();
  await page.getByRole('button', { name: 'Select & adjust' }).click();
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

test('view lock freezes pan and zoom while sign editing stays interactive', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.evaluate(() => {
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
    Element.prototype.hasPointerCapture = () => false;
  });

  await page.getByRole('button', { name: 'Fit canvas to screen' }).click();
  const surface = page.locator('#export-target');
  const bounds = await surface.boundingBox();
  expect(bounds).not.toBeNull();
  const center = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };

  await page.getByRole('button', { name: 'Lock canvas view' }).click();
  await expect(page.getByRole('button', { name: 'Unlock canvas view' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Fit canvas to screen' })).toBeDisabled();

  const lockedView = await transform(page);
  const viewport = '[data-testid="canvas-viewport"]';
  await dispatchTouch(page, 'pointerdown', 1, center.x - 50, center.y, viewport);
  await dispatchTouch(page, 'pointerdown', 2, center.x + 50, center.y, viewport);
  await dispatchTouch(page, 'pointermove', 1, center.x - 110, center.y + 45, viewport);
  await dispatchTouch(page, 'pointermove', 2, center.x + 110, center.y + 45, viewport);
  await dispatchTouch(page, 'pointerup', 1, center.x - 110, center.y + 45, viewport);
  await dispatchTouch(page, 'pointerup', 2, center.x + 110, center.y + 45, viewport);
  await page.waitForTimeout(50);
  const afterLockedGesture = await transform(page);
  expect(afterLockedGesture.x).toBeCloseTo(lockedView.x, 4);
  expect(afterLockedGesture.y).toBeCloseTo(lockedView.y, 4);
  expect(afterLockedGesture.scale).toBeCloseTo(lockedView.scale, 4);

  const moveHandle = page.getByTestId('sign-move-handle');
  await expect(moveHandle).toBeVisible();
  const moveBounds = await moveHandle.boundingBox();
  expect(moveBounds).not.toBeNull();
  const signCenter = { x: moveBounds!.x + moveBounds!.width / 2, y: moveBounds!.y + moveBounds!.height / 2 };
  await dispatchTouch(page, 'pointerdown', 1, signCenter.x, signCenter.y, '[data-testid="sign-move-handle"]');
  await dispatchTouch(page, 'pointermove', 1, signCenter.x + 32, signCenter.y + 20, '[data-testid="sign-move-handle"]');
  await dispatchTouch(page, 'pointerup', 1, signCenter.x + 32, signCenter.y + 20, '[data-testid="sign-move-handle"]');
  const movedBounds = await moveHandle.boundingBox();
  expect(movedBounds).not.toBeNull();
  expect(movedBounds!.x - moveBounds!.x).toBeCloseTo(32, 0);
  expect(movedBounds!.y - moveBounds!.y).toBeCloseTo(20, 0);

  await page.getByRole('button', { name: 'Unlock canvas view' }).click();
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
  await page.getByRole('button', { name: 'Pan view' }).click();
  const beforeUnlockedPan = await transform(page);
  await dispatchTouch(page, 'pointerdown', 1, center.x, center.y, viewport);
  await dispatchTouch(page, 'pointermove', 1, center.x + 55, center.y + 35, viewport);
  await dispatchTouch(page, 'pointerup', 1, center.x + 55, center.y + 35, viewport);
  await page.waitForTimeout(50);
  const afterUnlockedPan = await transform(page);
  expect(afterUnlockedPan.x - beforeUnlockedPan.x).toBeCloseTo(55, 0);
  expect(afterUnlockedPan.y - beforeUnlockedPan.y).toBeCloseTo(35, 0);
});

test('sign controls have iPad-sized targets and move on the first drag', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Select & adjust' }).click();
  await page.evaluate(() => {
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
    Element.prototype.hasPointerCapture = () => false;
  });

  const cornerHandle = page.getByTestId('sign-corner-handle-0');
  const moveHandle = page.getByTestId('sign-move-handle');
  await expect(cornerHandle).toBeVisible();
  const cornerBounds = await cornerHandle.boundingBox();
  expect(cornerBounds).not.toBeNull();
  expect(cornerBounds!.width).toBeGreaterThanOrEqual(44);
  expect(cornerBounds!.height).toBeGreaterThanOrEqual(44);

  const moveBounds = await moveHandle.boundingBox();
  expect(moveBounds).not.toBeNull();
  const signCenter = {
    x: moveBounds!.x + moveBounds!.width / 2,
    y: moveBounds!.y + moveBounds!.height / 2,
  };

  // Deselect, then prove that the very first touch-and-drag both selects and
  // moves the sign. The old interaction required a separate selection tap.
  const surfaceBounds = await page.locator('#export-target').boundingBox();
  expect(surfaceBounds).not.toBeNull();
  await dispatchTouch(page, 'pointerdown', 1, surfaceBounds!.x + 12, surfaceBounds!.y + 12);
  await dispatchTouch(page, 'pointerup', 1, surfaceBounds!.x + 12, surfaceBounds!.y + 12);
  await expect(moveHandle).toHaveCount(0);

  const signHitTarget = '[data-testid^="sign-hit-area-"]';
  await dispatchTouch(page, 'pointerdown', 1, signCenter.x, signCenter.y, signHitTarget);
  await dispatchTouch(page, 'pointermove', 1, signCenter.x + 48, signCenter.y + 30, signHitTarget);
  await dispatchTouch(page, 'pointerup', 1, signCenter.x + 48, signCenter.y + 30, signHitTarget);
  await expect(moveHandle).toBeVisible();

  const movedBounds = await moveHandle.boundingBox();
  expect(movedBounds).not.toBeNull();
  const movedCenter = {
    x: movedBounds!.x + movedBounds!.width / 2,
    y: movedBounds!.y + movedBounds!.height / 2,
  };
  expect(movedCenter.x - signCenter.x).toBeCloseTo(48, 0);
  expect(movedCenter.y - signCenter.y).toBeCloseTo(30, 0);

  const moreControls = page.getByRole('button', { name: 'Open all controls' });
  if (await moreControls.isVisible()) await moreControls.click();
  await page.getByRole('button', { name: '5 pixel nudge step' }).click();
  const beforeNudge = await moveHandle.boundingBox();
  await page.getByRole('button', { name: 'Nudge sign right' }).click();
  await expect.poll(async () => (await moveHandle.boundingBox())!.x).toBeGreaterThan(beforeNudge!.x);
});
