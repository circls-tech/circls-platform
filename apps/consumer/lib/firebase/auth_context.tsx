'use client';
import {
  type ConfirmationResult,
  type User,
  RecaptchaVerifier,
  onAuthStateChanged,
  signInWithPhoneNumber,
  signOut as fbSignOut,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api/client';
import { auth } from './client';

/** Best-effort login audit — must never block or fail the sign-in flow. */
function recordLogin(): void {
  void apiFetch('/v1/me/login', {
    method: 'POST',
    body: JSON.stringify({ source: 'consumer' }),
  }).catch(() => {});
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /**
   * Starts phone sign-in: builds a fresh invisible reCAPTCHA verifier and sends
   * an SMS OTP to `phoneE164` (e.g. "+919876543210"). Stores the
   * ConfirmationResult for the subsequent confirmOtp() call. Safe to call again
   * to resend a code to the same number.
   */
  startPhoneSignIn: (phoneE164: string) => Promise<void>;
  /** Confirms the SMS code from the active ConfirmationResult; resolves to the user. */
  confirmOtp: (code: string) => Promise<User>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Stable id for the invisible reCAPTCHA container that AuthProvider renders. */
const RECAPTCHA_CONTAINER_ID = 'circls-recaptcha-container';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // The verifier + confirmation result live across renders but aren't state —
  // changing them shouldn't trigger re-renders.
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  const confirmationRef = useRef<ConfirmationResult | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  // Tear down the verifier when the provider unmounts.
  useEffect(() => {
    return () => {
      verifierRef.current?.clear();
      verifierRef.current = null;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      async startPhoneSignIn(phoneE164) {
        // A reCAPTCHA token is single-use, so a verifier that has already sent
        // an SMS can't send a second one — which is what a resend asks it to
        // do. Tear down whatever is there and build fresh on every send.
        verifierRef.current?.clear();
        verifierRef.current = new RecaptchaVerifier(auth, RECAPTCHA_CONTAINER_ID, {
          size: 'invisible',
        });
        try {
          confirmationRef.current = await signInWithPhoneNumber(
            auth,
            phoneE164.trim(),
            verifierRef.current,
          );
        } catch (err) {
          // A failed send can leave the widget unusable — reset so the next
          // "Send code" gets a fresh verifier.
          verifierRef.current?.clear();
          verifierRef.current = null;
          throw err;
        }
      },
      async confirmOtp(code) {
        const confirmation = confirmationRef.current;
        if (!confirmation) {
          throw new Error('No verification in progress. Please request a new code.');
        }
        const cred = await confirmation.confirm(code.trim());
        confirmationRef.current = null;
        recordLogin();
        return cred.user;
      },
      async signOut() {
        await fbSignOut(auth);
        confirmationRef.current = null;
      },
    }),
    [user, loading],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {/* Invisible reCAPTCHA target — required by Firebase phone auth. */}
      <div id={RECAPTCHA_CONTAINER_ID} />
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
