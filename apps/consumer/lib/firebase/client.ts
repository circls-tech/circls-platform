import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

// Firebase *web* config is not secret (it ships in the client bundle). Real
// production (circls-418b6) values are the defaults so builds work out of the
// box; override per-environment via NEXT_PUBLIC_FIREBASE_* env vars.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'AIzaSyAAcZ4HuHi8qLNyPSv8UDwxLScOurbxdx4',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? 'circls-418b6.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'circls-418b6',
  appId:
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '1:899449370946:web:575fec8cce5484d06f70db',
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
