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

test('desktop Select & adjust handles show a precision magnifier', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop pointer precision coverage.');

  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: 'Select & adjust' }).click();

  const loupe = page.getByTestId('precision-loupe');
  const corner = page.getByTestId('sign-corner-handle-0');
  const cornerBefore = await corner.boundingBox();
  expect(cornerBefore).not.toBeNull();
  const cornerStart = {
    x: cornerBefore!.x + cornerBefore!.width / 2,
    y: cornerBefore!.y + cornerBefore!.height / 2,
  };

  await page.mouse.move(cornerStart.x, cornerStart.y);
  await page.mouse.down();
  await expect(loupe).toBeVisible();
  await expect(loupe).toHaveAttribute('data-loupe-kind', 'sign');
  const firstLoupeStyle = await loupe.getAttribute('style');
  await page.mouse.move(cornerStart.x + 28, cornerStart.y + 18);
  await expect.poll(() => loupe.getAttribute('style')).not.toBe(firstLoupeStyle);
  await page.mouse.up();
  await expect(loupe).toBeHidden();
  await expect.poll(async () => (await corner.boundingBox())!.x).toBeGreaterThan(cornerBefore!.x + 20);

  const moveHandle = page.getByTestId('sign-move-handle');
  const moveBounds = await moveHandle.boundingBox();
  expect(moveBounds).not.toBeNull();
  await page.mouse.move(moveBounds!.x + moveBounds!.width / 2, moveBounds!.y + moveBounds!.height / 2);
  await page.mouse.down();
  await expect(loupe).toBeHidden();
  await page.mouse.up();

  const scaleHandle = page.getByTestId('sign-scale-handle');
  const scaleBounds = await scaleHandle.boundingBox();
  expect(scaleBounds).not.toBeNull();
  await page.mouse.move(scaleBounds!.x + scaleBounds!.width / 2, scaleBounds!.y + scaleBounds!.height / 2);
  await page.mouse.down();
  await expect(loupe).toBeHidden();
  await page.mouse.up();

  await calibrateCanvas(page);
  const surface = page.locator('#export-target');
  const surfaceBounds = await surface.boundingBox();
  expect(surfaceBounds).not.toBeNull();
  await page.getByRole('button', { name: 'Measure line' }).click();
  await surface.click({ position: { x: surfaceBounds!.width * 0.3, y: surfaceBounds!.height * 0.7 } });
  await surface.click({ position: { x: surfaceBounds!.width * 0.65, y: surfaceBounds!.height * 0.7 } });
  await page.getByRole('button', { name: 'Select & adjust' }).click();

  const dimensionHandle = page.locator('[data-dimension-handle="0"]').first();
  const dimensionBefore = await dimensionHandle.boundingBox();
  expect(dimensionBefore).not.toBeNull();
  await page.mouse.move(
    dimensionBefore!.x + dimensionBefore!.width / 2,
    dimensionBefore!.y + dimensionBefore!.height / 2,
  );
  await page.mouse.down();
  await expect(loupe).toHaveAttribute('data-loupe-kind', 'dimension');
  await page.mouse.move(dimensionBefore!.x + dimensionBefore!.width / 2 + 24, dimensionBefore!.y + dimensionBefore!.height / 2 + 12);
  await page.mouse.up();
  await expect(loupe).toBeHidden();
  await expect.poll(async () => (await dimensionHandle.boundingBox())!.x).toBeGreaterThan(dimensionBefore!.x + 16);

  const dimensionEndHandle = page.locator('[data-dimension-handle="1"]').first();
  const movedStartBefore = await dimensionHandle.boundingBox();
  const movedEndBefore = await dimensionEndHandle.boundingBox();
  expect(movedStartBefore).not.toBeNull();
  expect(movedEndBefore).not.toBeNull();
  const lineMovePoint = {
    x: movedStartBefore!.x + movedStartBefore!.width / 2
      + ((movedEndBefore!.x + movedEndBefore!.width / 2) - (movedStartBefore!.x + movedStartBefore!.width / 2)) * 0.35,
    y: movedStartBefore!.y + movedStartBefore!.height / 2
      + ((movedEndBefore!.y + movedEndBefore!.height / 2) - (movedStartBefore!.y + movedStartBefore!.height / 2)) * 0.35,
  };
  await page.mouse.move(lineMovePoint.x, lineMovePoint.y);
  await page.mouse.down();
  await expect(loupe).toBeHidden();
  await page.mouse.move(lineMovePoint.x + 20, lineMovePoint.y + 10);
  await page.mouse.up();
  await expect.poll(async () => (await dimensionHandle.boundingBox())!.x).toBeGreaterThan(movedStartBefore!.x + 14);
  await expect.poll(async () => (await dimensionEndHandle.boundingBox())!.x).toBeGreaterThan(movedEndBefore!.x + 14);

  // A visible endpoint must remain directly editable even after the dimension
  // has been deselected. Previously the handler silently targeted only the
  // stale active dimension, so this drag did nothing.
  await surface.click({ position: { x: surfaceBounds!.width * 0.08, y: surfaceBounds!.height * 0.08 } });
  const deselectedHandleBefore = await dimensionEndHandle.boundingBox();
  expect(deselectedHandleBefore).not.toBeNull();
  await page.mouse.move(
    deselectedHandleBefore!.x + deselectedHandleBefore!.width / 2,
    deselectedHandleBefore!.y + deselectedHandleBefore!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(deselectedHandleBefore!.x + deselectedHandleBefore!.width / 2 + 28, deselectedHandleBefore!.y + deselectedHandleBefore!.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await dimensionEndHandle.boundingBox())!.x).toBeGreaterThan(deselectedHandleBefore!.x + 20);

  await page.getByRole('button', { name: 'Width × height' }).click();
  await surface.click({ position: { x: surfaceBounds!.width * 0.45, y: surfaceBounds!.height * 0.32 } });
  await surface.click({ position: { x: surfaceBounds!.width * 0.72, y: surfaceBounds!.height * 0.54 } });
  await page.getByRole('button', { name: 'Select & adjust' }).click();
  const boxCorner = page.locator('[data-dimension-handle="10"]');
  const boxCornerBefore = await boxCorner.boundingBox();
  expect(boxCornerBefore).not.toBeNull();
  await page.mouse.move(boxCornerBefore!.x + boxCornerBefore!.width / 2, boxCornerBefore!.y + boxCornerBefore!.height / 2);
  await page.mouse.down();
  await expect(loupe).toHaveAttribute('data-loupe-kind', 'dimension');
  await page.mouse.move(boxCornerBefore!.x + boxCornerBefore!.width / 2 - 18, boxCornerBefore!.y + boxCornerBefore!.height / 2 - 12);
  await page.mouse.up();
  await expect(loupe).toBeHidden();
  await expect.poll(async () => (await boxCorner.boundingBox())!.x).toBeLessThan(boxCornerBefore!.x - 10);

  const dimensionLabel = page.locator('[data-testid^="dimension-label-"]').first();
  const labelBeforeZoomOut = await dimensionLabel.boundingBox();
  expect(labelBeforeZoomOut).not.toBeNull();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect.poll(async () => (await dimensionLabel.boundingBox())!.width).toBeLessThan(labelBeforeZoomOut!.width * 0.82);
});

test('background upload retains its full source dimensions for editing', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Full-resolution import is covered once in the desktop browser.');

  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const moreControls = page.getByRole('button', { name: 'Open all controls' });
  if (await moreControls.isVisible()) await moreControls.click();
  await page.getByRole('button', { name: 'New Image / Camera' }).click();

  const sourceWidth = 4608;
  const sourceHeight = 2592;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sourceWidth}" height="${sourceHeight}" viewBox="0 0 ${sourceWidth} ${sourceHeight}"><rect width="100%" height="100%" fill="#314158"/><circle cx="2304" cy="1296" r="520" fill="#38bdf8"/></svg>`;
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'full-resolution-background.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(svg),
  });

  const confirmCrop = page.getByTestId('confirm-image-crop');
  await expect(confirmCrop).toContainText('Use full-resolution crop');
  await confirmCrop.click();
  await expect(confirmCrop).toBeHidden();
  const background = page.locator('#export-target img[alt="Background"]');
  await expect(background).toBeVisible();
  await expect.poll(() => background.evaluate(image => ({
    width: (image as HTMLImageElement).naturalWidth,
    height: (image as HTMLImageElement).naturalHeight,
  }))).toEqual({ width: sourceWidth, height: sourceHeight });
  await expect.poll(() => page.locator('#export-target').evaluate(element => ({
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }))).toEqual({ width: sourceWidth, height: sourceHeight });

  const signCanvas = page.locator('#export-target canvas').first();
  const preview = await signCanvas.evaluate(canvas => ({
    width: (canvas as HTMLCanvasElement).width,
    height: (canvas as HTMLCanvasElement).height,
  }));
  expect(preview).toEqual({ width: 2730, height: 1536 });
  expect(preview.width * preview.height).toBeLessThanOrEqual(4_194_304);

  await page.getByTitle('Crop Background').click();
  await expect(page.getByRole('button', { name: 'Apply crop' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply crop' }).click();
  await expect(page.getByRole('button', { name: 'Apply crop' })).toBeHidden();
  await expect.poll(() => background.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(sourceWidth);

  await page.getByRole('button', { name: 'Select & adjust' }).click();
  const corner = page.getByTestId('sign-corner-handle-0');
  const cornerBounds = await corner.boundingBox();
  expect(cornerBounds).not.toBeNull();
  await page.mouse.move(cornerBounds!.x + cornerBounds!.width / 2, cornerBounds!.y + cornerBounds!.height / 2);
  await page.mouse.down();
  const precisionLoupe = page.getByTestId('precision-loupe');
  await expect(precisionLoupe).toHaveAttribute('data-loupe-kind', 'sign');
  const loupeLayout = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="precision-loupe"]')!;
    const crosshair = document.querySelector('[data-testid="precision-loupe-crosshair-center"]')!;
    const loupeRect = element.getBoundingClientRect();
    const crosshairRect = crosshair.getBoundingClientRect();
    return {
      borderWidth: getComputedStyle(element).borderLeftWidth,
      loupeCenter: { x: loupeRect.left + loupeRect.width / 2, y: loupeRect.top + loupeRect.height / 2 },
      crosshairCenter: { x: crosshairRect.left + crosshairRect.width / 2, y: crosshairRect.top + crosshairRect.height / 2 },
    };
  });
  expect(loupeLayout.borderWidth).toBe('0px');
  expect(loupeLayout.crosshairCenter.x).toBeCloseTo(loupeLayout.loupeCenter.x, 3);
  expect(loupeLayout.crosshairCenter.y).toBeCloseTo(loupeLayout.loupeCenter.y, 3);
  const loupeBoundary = () => page.getByTestId('precision-loupe-sign-layer').evaluate(node => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) return { outside: 0, inside: 0 };
    const center = Math.floor(canvas.width / 2);
    // Sample immediately across the corner/crosshair intersection. A wider
    // sample would miss a few-pixel border-box offset in the loupe layers.
    const offset = Math.max(2, Math.floor(canvas.width * 0.025));
    return {
      outside: context.getImageData(center - offset, center - offset, 1, 1).data[3],
      inside: context.getImageData(center + offset, center + offset, 1, 1).data[3],
    };
  });
  await expect.poll(async () => (await loupeBoundary()).outside).toBe(0);
  await expect.poll(async () => (await loupeBoundary()).inside).toBeGreaterThan(200);
  await page.mouse.up();
});

test('uploaded PNG signs retain enough source pixels for sharp canvas rendering', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'High-resolution sign import is covered once in the desktop browser.');

  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const sourceWidth = 4096;
  const sourceHeight = 1024;
  const pngDataUrl = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#ffffff';
    context.fillRect(64, 64, width - 128, height - 128);
    context.fillStyle = '#0f172a';
    context.font = 'bold 420px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('SHARP SIGN', width / 2, height / 2);
    return canvas.toDataURL('image/png');
  }, { width: sourceWidth, height: sourceHeight });

  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'sharp-sign.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngDataUrl.split(',')[1], 'base64'),
  });
  const confirmCrop = page.getByTestId('confirm-image-crop');
  await confirmCrop.click();
  await expect(confirmCrop).toBeHidden();

  const uploadedSign = page.locator('img[src^="data:image/png;base64"]').last();
  await expect(uploadedSign).toBeVisible();
  await expect.poll(() => uploadedSign.evaluate(image => ({
    width: (image as HTMLImageElement).naturalWidth,
    height: (image as HTMLImageElement).naturalHeight,
  }))).toEqual({ width: sourceWidth, height: sourceHeight });
});

test('background upload can optionally level a drawn horizontal at full editing resolution', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The leveling geometry is device-independent and covered once.');

  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const openAllControls = page.getByRole('button', { name: 'Open all controls' });
  if (await openAllControls.isVisible()) await openAllControls.click();
  await page.getByRole('button', { name: /New Image \/ Camera/ }).click();

  const toggle = page.getByRole('switch', { name: 'Level photo' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  const pngDataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#dbeafe';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#0f172a';
    context.lineWidth = 20;
    context.beginPath();
    context.moveTo(180, 300);
    context.lineTo(1020, 390);
    context.stroke();
    return canvas.toDataURL('image/png');
  });
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'tilted-facade.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngDataUrl.split(',')[1], 'base64'),
  });

  await expect(page.getByText('Level Photo')).toBeVisible();
  const levelCanvas = page.getByTestId('level-photo-canvas');
  const bounds = await levelCanvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.22, bounds!.y + bounds!.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.78, bounds!.y + bounds!.height * 0.53);
  await page.mouse.up();
  await expect(page.getByTestId('level-angle')).not.toHaveText('0.0°');
  await page.getByTestId('apply-photo-level').click();
  await expect(page.getByText('Crop & Convert')).toBeVisible();
  await page.getByTestId('confirm-image-crop').click();
  await expect(page.getByText('Select Image Source')).toBeHidden();
});

test('photo location requires confirmation before populating the title-block address', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The permission and confirmation flow is covered once.');
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: -33.9249, longitude: 18.4241, accuracy: 8 } } as GeolocationPosition) },
    });
  });
  await page.route('**/api/geocode', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ address: '1 Test Street, Cape Town, South Africa', placeId: 'place-1' }),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  const openAllControls = page.getByRole('button', { name: 'Open all controls' });
  if (await openAllControls.isVisible()) await openAllControls.click();
  await page.getByRole('button', { name: /New Image \/ Camera/ }).click();
  const locationToggle = page.getByRole('switch', { name: 'Use photo location' });
  await locationToggle.click();
  await expect(locationToggle).toHaveAttribute('aria-checked', 'true');

  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 500;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#cbd5e1'; context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  });
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: 'no-gps.png', mimeType: 'image/png', buffer: Buffer.from(image.split(',')[1], 'base64') });
  const panel = page.getByTestId('photo-location-panel');
  await expect(panel).toContainText('no embedded GPS');
  await panel.getByRole('button', { name: 'Use current location' }).click();
  const address = panel.getByRole('textbox', { name: 'Detected photo address' });
  await expect(address).toHaveValue('1 Test Street, Cape Town, South Africa');
  await panel.getByRole('button', { name: 'Use address' }).click();
  await expect(panel.getByRole('button', { name: 'Address confirmed' })).toBeVisible();
  await page.getByTestId('confirm-image-crop').click();
  await expect(page.getByText('Title-block address updated from the confirmed photo location.')).toBeVisible();
});
