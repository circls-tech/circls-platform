'use client';
import {
  type User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail as fbSendReset,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api/client';
import { auth } from './client';

/**
 * Sends the Firebase verification email with a continue URL, so the "email
 * verified" page links back to the portal. Each send invalidates the previous
 * link. If this origin isn't an authorised continue domain, fall back to a
 * plain send rather than sending nothing.
 */
export async function sendVerificationEmail(user: User): Promise<void> {
  try {
    await sendEmailVerification(user, { url: window.location.origin });
  } catch (e) {
    if ((e as { code?: string }).code !== 'auth/unauthorized-continue-uri') throw e;
    await sendEmailVerification(user);
  }
}

/** Best-effort login audit — must never block or fail the sign-in flow. */
function recordLogin(): void {
  void apiFetch('/v1/me/login', {
    method: 'POST',
    body: JSON.stringify({ source: 'partners' }),
  }).catch(() => {});
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signInWithEmail: (email: string, password: string) => Promise<User>;
  signUpWithEmail: (email: string, password: string) => Promise<User>;
  sendPasswordReset: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      async signInWithEmail(email, password) {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
        recordLogin();
        return cred.user;
      },
      async signUpWithEmail(email, password) {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        // Best-effort: signup works unverified, but the API only trusts (and
        // stores) the email once Firebase verifies it — the layout banner
        // offers a re-send until then.
        void sendVerificationEmail(cred.user).catch(() => {});
        recordLogin();
        return cred.user;
      },
      async sendPasswordReset(email) {
        await fbSendReset(auth, email.trim());
      },
      async signOut() {
        await fbSignOut(auth);
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
