import { getApp, getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';

// Same Firebase project as partners — separate web app id is fine if the
// project later splits, but for now we share. Web config is not secret.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'AIzaSyAAcZ4HuHi8qLNyPSv8UDwxLScOurbxdx4',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? 'circls-418b6.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? 'circls-418b6',
  appId:
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? '1:899449370946:web:575fec8cce5484d06f70db',
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);

// Local sandbox only: point the web SDK at the Firebase Auth Emulator so phone
// OTPs are shown (in the emulator UI / logs) instead of texted, and no real
// project is touched. Gated by NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1; never on in
// prod. Browser-only (the emulator host is reachable from the user's machine).
if (process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === '1' && typeof window !== 'undefined') {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
}
