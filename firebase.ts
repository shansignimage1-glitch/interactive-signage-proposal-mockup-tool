import { getApps, initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// Dedicated project for this app only. Never point this configuration at the
// shared signimage-cc project used by unrelated business applications.
const firebaseConfig = {
  apiKey: 'AIzaSyDeUpqPjtmstY-_V5v-fGGtNXn9B4H1vFI',
  authDomain: 'sunny-ship-437805-c5.firebaseapp.com',
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
export default app;
