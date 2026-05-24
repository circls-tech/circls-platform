'use client';
import {
  type ConfirmationResult,
  RecaptchaVerifier,
  type User,
  onAuthStateChanged,
  signInWithPhoneNumber,
  signOut as fbSignOut,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { auth } from './client';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** Send an OTP to an E.164 phone number; returns a confirmation to `.confirm(code)`. */
  sendOtp: (phoneE164: string) => Promise<ConfirmationResult>;
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
      async sendOtp(phoneE164: string) {
        // invisible reCAPTCHA, same UX as legacy circls.app
        const verifier = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'invisible' });
        return signInWithPhoneNumber(auth, phoneE164, verifier);
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
