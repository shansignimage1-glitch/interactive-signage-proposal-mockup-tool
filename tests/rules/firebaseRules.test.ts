import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { getBytes, listAll, ref, uploadBytes } from 'firebase/storage';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'signagepro-rules-test',
    firestore: { rules: readFileSync(resolve('firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync(resolve('storage.rules'), 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});

beforeEach(async () => env.clearFirestore());
afterAll(async () => env.cleanup());

describe('Firestore project rules', () => {
  it('allows owners and denies other users', async () => {
    const ownerDb = env.authenticatedContext('owner').firestore();
    const strangerDb = env.authenticatedContext('stranger').firestore();
    const project = doc(ownerDb, 'projects/owner_project');
    await assertSucceeds(setDoc(project, { userId: 'owner', projectId: 'project' }));
    await assertSucceeds(getDoc(project));
    await assertFails(getDoc(doc(strangerDb, 'projects/owner_project')));
    await assertFails(deleteDoc(doc(strangerDb, 'projects/owner_project')));
  });

  it('rejects forged ownership and unauthenticated access', async () => {
    const userDb = env.authenticatedContext('user-a').firestore();
    const publicDb = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(userDb, 'projects/forged'), { userId: 'user-b' }));
    await assertFails(getDoc(doc(publicDb, 'projects/anything')));
  });

  it('limits shared-library writes to the configured administrator', async () => {
    const adminDb = env.authenticatedContext('admin', { admin: true }).firestore();
    const userDb = env.authenticatedContext('user', { admin: false }).firestore();
    await assertSucceeds(setDoc(doc(adminDb, 'library/item-1'), { name: 'Logo' }));
    await assertSucceeds(getDoc(doc(userDb, 'library/item-1')));
    await assertFails(setDoc(doc(userDb, 'library/item-2'), { name: 'Forged' }));
  });
});

describe('Storage rules', () => {
  it('isolates every user folder', async () => {
    const ownerStorage = env.authenticatedContext('owner').storage();
    const strangerStorage = env.authenticatedContext('stranger').storage();
    const bytes = new TextEncoder().encode('image');
    await assertSucceeds(uploadBytes(ref(ownerStorage, 'users/owner/images/a'), bytes));
    await assertSucceeds(getBytes(ref(ownerStorage, 'users/owner/images/a')));
    await assertSucceeds(listAll(ref(ownerStorage, 'users/owner/images')));
    await assertFails(getBytes(ref(strangerStorage, 'users/owner/images/a')));
    await assertFails(listAll(ref(strangerStorage, 'users/owner/images')));
    await assertFails(uploadBytes(ref(strangerStorage, 'users/owner/images/b'), bytes));
  });

  it('allows signed-in library reads but only administrator writes', async () => {
    const adminStorage = env.authenticatedContext('admin', { admin: true }).storage();
    const userStorage = env.authenticatedContext('user', { admin: false }).storage();
    const publicStorage = env.unauthenticatedContext().storage();
    const bytes = new TextEncoder().encode('template');
    await assertSucceeds(uploadBytes(ref(adminStorage, 'library/template-a'), bytes));
    await assertSucceeds(getBytes(ref(userStorage, 'library/template-a')));
    await assertFails(uploadBytes(ref(userStorage, 'library/template-b'), bytes));
    await assertFails(getBytes(ref(publicStorage, 'library/template-a')));
  });
});
