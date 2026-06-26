'use client';
import {
  type User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail as fbSendReset,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api/client';
import { auth } from './client';

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
