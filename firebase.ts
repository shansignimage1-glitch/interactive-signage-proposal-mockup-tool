
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/storage';

// TODO: Replace with your actual config from Firebase Console > Project Settings
const firebaseConfig = {
  apiKey: "AIzaSyBI6MwVl3eV85X4qh3EGQj8djM3z_yKV7A",
  authDomain: "signimage-cc.firebaseapp.com",
  projectId: "signimage-cc",
  storageBucket: "signimage-cc.firebasestorage.app",
  messagingSenderId: "1069418454987",
  appId: "1:1069418454987:web:f5d4840e7d75c3891fa04e"
};

// Initialize Firebase (Singleton pattern)
const app = !firebase.apps.length ? firebase.initializeApp(firebaseConfig) : firebase.app();

// Initialize Services (v8 style)
export const auth = app.auth();
export const googleProvider = new firebase.auth.GoogleAuthProvider();
export const db = app.firestore();
export const storage = app.storage();

export default app;

