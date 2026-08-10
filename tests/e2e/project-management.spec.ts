import { expect, test } from '@playwright/test';

test('projects can be explicitly saved, renamed, and permanently deleted', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Project persistence lifecycle is covered once.');
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();

  await page.getByRole('button', { name: 'Manage projects' }).click();
  const manager = page.getByRole('heading', { name: 'Project Manager' }).locator('..').locator('..');
  await expect(manager).toBeVisible();
  await page.getByRole('button', { name: 'Save current project' }).click();
  const projectName = page.getByLabel('Project Name');
  await projectName.fill('Project Lifecycle Test');
  await page.getByRole('button', { name: 'Save to Database' }).click();
  await expect(page.getByText('Project saved.')).toBeVisible();
  await expect(manager.getByText('Project Lifecycle Test', { exact: true })).toBeVisible();

  const postSave = page.getByTestId('post-save-new-project');
  await expect(postSave).toContainText('Project saved safely');
  await postSave.getByRole('button', { name: 'Start new project' }).click();
  await expect(page.getByText('New clean project started.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project Manager' })).toBeHidden();
  await expect(page.getByTestId('controls-panel').getByText('Untitled Project', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid^="sign-hit-area-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="dimension-label-"]')).toHaveCount(0);
  const cleanState = await page.evaluate(async () => {
    const id = localStorage.getItem('signagepro_guest_project_id');
    const request = indexedDB.open('SignageProDB', 4);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const get = db.transaction('projects', 'readonly').objectStore('projects').get(id!);
    const project = await new Promise<any>((resolve, reject) => { get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    return {
      signs: project.canvases[0].signs.length,
      dimensions: project.canvases[0].dimensions.length,
      calibration: project.canvases[0].calibration ?? null,
      notes: project.notes,
      references: project.referenceImages.length,
      revisions: project.titleBlock.revisions.length,
      populatedFields: project.titleBlock.fields.filter((field: any) => field.value).length,
    };
  });
  expect(cleanState).toEqual({ signs: 0, dimensions: 0, calibration: null, notes: '', references: 0, revisions: 0, populatedFields: 0 });

  await page.getByRole('button', { name: 'View 1', exact: true }).click();
  await page.getByRole('button', { name: 'Add New View' }).click();
  await expect(page.getByRole('button', { name: 'View 2', exact: true })).toBeVisible();
  await page.waitForTimeout(3_500);
  const newView = await page.evaluate(async () => {
    const id = localStorage.getItem('signagepro_guest_project_id');
    const request = indexedDB.open('SignageProDB', 4);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const get = db.transaction('projects', 'readonly').objectStore('projects').get(id!);
    const project = await new Promise<any>((resolve, reject) => { get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    return project.canvases[1];
  });
  expect(newView.backgroundImage).toContain("fill='%23e5e7eb'");
  expect(newView.signs).toHaveLength(0);
  expect(newView.dimensions).toHaveLength(0);
  expect(newView.calibration ?? null).toBeNull();

  await page.getByRole('button', { name: 'View 2', exact: true }).click();
  await page.getByRole('button', { name: 'View 1', exact: true }).click();
  await page.getByTitle('Delete current view').click();
  await expect(page.getByRole('button', { name: 'View 1', exact: true })).toBeVisible();
  await page.waitForTimeout(3_500);
  const viewsAfterDelete = await page.evaluate(async () => {
    const id = localStorage.getItem('signagepro_guest_project_id');
    const request = indexedDB.open('SignageProDB', 4);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const get = db.transaction('projects', 'readonly').objectStore('projects').get(id!);
    const project = await new Promise<any>((resolve, reject) => { get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
    return project.canvases.map((canvas: any) => ({ name: canvas.name, sheetTitle: canvas.sheetTitle, sheetNumber: canvas.sheetNumber }));
  });
  expect(viewsAfterDelete).toEqual([{ name: 'View 1', sheetTitle: 'ELEVATION 1', sheetNumber: 'A-101' }]);

  await page.getByRole('button', { name: 'Manage projects' }).click();
  await expect(manager.getByText('Project Lifecycle Test', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit project Project Lifecycle Test' }).click();
  const editName = page.getByRole('textbox', { name: 'Edit project name Project Lifecycle Test' });
  await editName.fill('Renamed Project');
  await page.getByRole('button', { name: 'Save project name' }).click();
  await expect(page.getByText('Project name updated.')).toBeVisible();
  await expect(manager.getByText('Renamed Project', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Delete project Renamed Project' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).not.toContainText('currently open');
  await dialog.getByRole('button', { name: 'Delete project' }).click();
  await expect(page.getByText('Project deleted.', { exact: true })).toBeVisible();

  await page.waitForTimeout(3_500);
  await expect(page.getByText('Renamed Project', { exact: true })).toHaveCount(0);
});
