import { getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

// Dedicated project for this app only. Never point this configuration at the
// shared signimage-cc project used by unrelated business applications.
const productionHost = 'signage-proposal-mockup-tool.vercel.app';
const isProductionOrigin = typeof window !== 'undefined' && window.location.hostname === productionHost;

const firebaseConfig = {
  apiKey: 'AIzaSyDeUpqPjtmstY-_V5v-fGGtNXn9B4H1vFI',
  // Safari blocks the third-party storage used by Firebase redirect auth when
  // the helper lives on firebaseapp.com. Production proxies /__/auth/* through
  // Vercel, so the helper and the app share one origin on iPad/iPhone.
  authDomain: isProductionOrigin ? productionHost : 'sunny-ship-437805-c5.firebaseapp.com',
  projectId: 'sunny-ship-437805-c5',
  storageBucket: 'sunny-ship-437805-c5.firebasestorage.app',
  messagingSenderId: '135421174269',
  appId: '1:135421174269:web:2c4cb3f2404f2093f7f994',
};

const app = getApps()[0] ?? initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);

const useFirebaseEmulators = import.meta.env.VITE_FIREBASE_EMULATORS === 'true';
if (useFirebaseEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}

/** Test-only sign-in entry point. The production build always rejects it. */
export const signInForFirebaseE2E = async (email: string, password: string) => {
  if (!useFirebaseEmulators) throw new Error('Firebase E2E sign-in is disabled outside the emulator build.');
  const { createUserWithEmailAndPassword, signInWithEmailAndPassword } = await import('firebase/auth');
  try {
    return await createUserWithEmailAndPassword(auth, email, password);
  } catch (error: any) {
    if (error?.code !== 'auth/email-already-in-use') throw error;
    return signInWithEmailAndPassword(auth, email, password);
  }
};
export default app;
