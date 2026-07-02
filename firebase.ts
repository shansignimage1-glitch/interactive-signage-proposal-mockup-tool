
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/storage';

// Dedicated project for this app only — do not point this at signimage-cc or any
// other shared project. That project's Storage/Firestore also serve unrelated
// business tools (invoicing, staff records, suppliers, quotes), and mixing them
// caused a real incident (see storage.rules / firestore.rules history).
const firebaseConfig = {
  apiKey: "AIzaSyDeUpqPjtmstY-_V5v-fGGtNXn9B4H1vFI",
  authDomain: "sunny-ship-437805-c5.firebaseapp.com",
  projectId: "sunny-ship-437805-c5",
  storageBucket: "sunny-ship-437805-c5.firebasestorage.app",
  messagingSenderId: "135421174269",
  appId: "1:135421174269:web:2c4cb3f2404f2093f7f994"
};

// Initialize Firebase (Singleton pattern)
const app = !firebase.apps.length ? firebase.initializeApp(firebaseConfig) : firebase.app();

// Initialize Services (v8 style)
export const auth = app.auth();
export const googleProvider = new firebase.auth.GoogleAuthProvider();
export const db = app.firestore();
export const storage = app.storage();

export default app;

