import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { deleteObject, getBytes, listAll, ref, uploadBytes } from 'firebase/storage';
import { encodeProjectForFirestore } from '../../utils/firestorePayload';
import { makeProject } from '../fixtures/project';

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

  it('lets an owner check an unsynced project path without exposing another user path', async () => {
    const ownerDb = env.authenticatedContext('owner').firestore();
    const strangerDb = env.authenticatedContext('stranger').firestore();
    await assertSucceeds(getDoc(doc(ownerDb, 'projects/owner_not-yet-synced')));
    await assertFails(getDoc(doc(strangerDb, 'projects/owner_not-yet-synced')));
  });

  it('rejects forged ownership and unauthenticated access', async () => {
    const userDb = env.authenticatedContext('user-a').firestore();
    const publicDb = env.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(userDb, 'projects/forged'), { userId: 'user-b' }));
    await assertFails(getDoc(doc(publicDb, 'projects/anything')));
  });

  it('does not let a project owner transfer ownership or read a mismatched prefixed document', async () => {
    const ownerDb = env.authenticatedContext('owner').firestore();
    const project = doc(ownerDb, 'projects/owner_project');
    await assertSucceeds(setDoc(project, { userId: 'owner', projectId: 'project' }));
    await assertFails(setDoc(project, { userId: 'stranger', projectId: 'project' }));

    await env.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'projects/owner_mismatched'), {
        userId: 'stranger', projectId: 'mismatched',
      });
    });
    await assertFails(getDoc(doc(ownerDb, 'projects/owner_mismatched')));
  });

  it('lets an owner mark a project deleted and restore it, but never a stranger', async () => {
    const ownerDb = env.authenticatedContext('owner').firestore();
    const strangerDb = env.authenticatedContext('stranger').firestore();
    const project = doc(ownerDb, 'projects/owner_trash');
    await assertSucceeds(setDoc(project, { userId: 'owner', projectId: 'trash', cloudRevision: 3 }));
    await assertFails(setDoc(doc(strangerDb, 'projects/owner_trash'), { userId: 'owner', projectId: 'trash', cloudRevision: 4, deletedAt: 1 }));
    await assertSucceeds(setDoc(project, { userId: 'owner', projectId: 'trash', cloudRevision: 4, deletedAt: Date.now() }));
    await assertSucceeds(setDoc(project, { userId: 'owner', projectId: 'trash', cloudRevision: 5 }));
    await assertSucceeds(deleteDoc(project));
  });

  it('accepts encoded sign contours that Firestore otherwise rejects as nested arrays', async () => {
    const ownerDb = env.authenticatedContext('owner').firestore();
    const project = makeProject({ user: { uid: 'owner', displayName: null, email: null, photoURL: null } });
    project.canvases[0].signs = [{
      id: 'sign-1', name: 'Letters', image: '',
      corners: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      signType: 'channel_face', extrusionEnabled: true, extrusionDepth: 15,
      extrusionAngle: 45, opacity: 1, blendMode: 'normal', sideColor: '#000000',
      elements: [{ id: 'a', name: 'A', enabled: true, depth: 10, contours: [[{ x: 1, y: 2 }]] }],
    }];

    await assertSucceeds(setDoc(doc(ownerDb, 'projects/owner_contours'), {
      ...encodeProjectForFirestore(project),
      userId: 'owner',
    }));
  });

  it('limits shared-library writes to the configured administrator', async () => {
    const adminDb = env.authenticatedContext('admin', { admin: true }).firestore();
    const userDb = env.authenticatedContext('user', { admin: false }).firestore();
    await assertSucceeds(setDoc(doc(adminDb, 'library/item-1'), { name: 'Logo' }));
    await assertSucceeds(getDoc(doc(userDb, 'library/item-1')));
    await assertFails(setDoc(doc(userDb, 'library/item-2'), { name: 'Forged' }));
  });
});

describe('Firestore personal library rules', () => {
  it('lets owners manage their own templates and hides them from other users', async () => {
    const ownerDb = env.authenticatedContext('owner').firestore();
    const strangerDb = env.authenticatedContext('stranger').firestore();
    const template = doc(ownerDb, 'userLibrary/owner_hash');
    await assertSucceeds(setDoc(template, { ownerUid: 'owner', name: 'Fascia' }));
    await assertSucceeds(getDoc(template));
    await assertSucceeds(setDoc(template, { ownerUid: 'owner', name: 'Renamed' }));
    await assertFails(getDoc(doc(strangerDb, 'userLibrary/owner_hash')));
    await assertFails(setDoc(doc(strangerDb, 'userLibrary/owner_hash'), { ownerUid: 'stranger', name: 'Hijack' }));
    await assertFails(deleteDoc(doc(strangerDb, 'userLibrary/owner_hash')));
    await assertSucceeds(deleteDoc(template));
  });

  it('rejects creating a template for someone else', async () => {
    const userDb = env.authenticatedContext('user-a').firestore();
    await assertFails(setDoc(doc(userDb, 'userLibrary/forged'), { ownerUid: 'user-b', name: 'Forged' }));
  });

  it('does not let an owner transfer a template into another user\'s library', async () => {
    const ownerDb = env.authenticatedContext('owner').firestore();
    const template = doc(ownerDb, 'userLibrary/owner_transfer');
    await assertSucceeds(setDoc(template, { ownerUid: 'owner', name: 'Mine' }));
    await assertFails(setDoc(template, { ownerUid: 'victim', name: 'Planted' }));
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

  it('caps upload sizes, allowing larger full-resolution capture originals', async () => {
    const ownerStorage = env.authenticatedContext('owner').storage();
    const MB = 1024 * 1024;
    const bytes = (size: number) => new Uint8Array(size);
    const capture = 'users/owner/captures/project-1/capture-1';

    // Normal app files: fine up to the general cap, rejected beyond it.
    await assertSucceeds(uploadBytes(ref(ownerStorage, `${capture}/working`), bytes(2 * MB)));
    await assertFails(uploadBytes(ref(ownerStorage, `${capture}/working-big`), bytes(50 * MB + 1)));
    await assertFails(uploadBytes(ref(ownerStorage, 'users/owner/images/huge'), bytes(50 * MB + 1)));

    // Originals (incl. restore copies) get the larger allowance, but not unlimited.
    await assertSucceeds(uploadBytes(ref(ownerStorage, `${capture}/original`), bytes(80 * MB)));
    await assertSucceeds(uploadBytes(ref(ownerStorage, `${capture}/original-restore-attempt1`), bytes(60 * MB)));
    // The 150 MB ceiling for originals can't be exercised here: the Storage
    // emulator rejects request bodies of that size before evaluating rules.

    // A file merely named "original" elsewhere does not get the allowance.
    await assertFails(uploadBytes(ref(ownerStorage, 'users/owner/images/original'), bytes(60 * MB)));

    // Caps never block deleting.
    await assertSucceeds(deleteObject(ref(ownerStorage, `${capture}/original`)));
  }, 120_000);

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
