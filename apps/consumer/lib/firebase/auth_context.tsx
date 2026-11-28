'use client';
import {
  type ConfirmationResult,
  type User,
  RecaptchaVerifier,
  onAuthStateChanged,
  signInWithCustomToken,
  signInWithPhoneNumber,
  signOut as fbSignOut,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiFetch } from '@/lib/api/client';
import { auth } from './client';

/** Best-effort login audit — must never block or fail the sign-in flow. */
function recordLogin(): void {
  void apiFetch('/v1/me/login', {
    method: 'POST',
    body: JSON.stringify({ source: 'consumer' }),
  }).catch(() => {});
}

/** What POST /v1/auth/phone/start answers. */
type PhoneStart =
  | { provider: 'firebase' }
  | { provider: 'circls'; expiresInSec: number; resendAfterSec: number };

/**
 * Asks the API who texts this number's code. Indian numbers can get theirs
 * from Circls (through MSG91, a fraction of Firebase's SMS price); when Circls
 * has sent one, it's on its way. Only a deliberate refusal (400 bad number,
 * 429 too many codes) stops sign-in here: an API that can't be reached, or an
 * older one without the route, means Firebase — as it always was.
 */
async function startCirclsCode(phoneE164: string): Promise<boolean> {
  try {
    const res = await apiFetch<PhoneStart>('/v1/auth/phone/start', {
      method: 'POST',
      body: JSON.stringify({ phone: phoneE164 }),
    });
    return res.provider === 'circls';
  } catch (err) {
    if (err instanceof ApiError && (err.status === 400 || err.status === 429)) throw err;
    return false;
  }
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /**
   * Starts phone sign-in and texts a code to `phoneE164` (e.g.
   * "+919876543210"): through Circls when the API says so, otherwise through
   * Firebase with a fresh invisible reCAPTCHA verifier, keeping the
   * ConfirmationResult for confirmOtp(). Safe to call again to resend a code
   * to the same number.
   */
  startPhoneSignIn: (phoneE164: string) => Promise<void>;
  /** Checks the code with whichever sender texted it; resolves to the signed-in user. */
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
  // The number Circls texted the live code to; null while Firebase sent it.
  const circlsPhoneRef = useRef<string | null>(null);

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
        const phone = phoneE164.trim();
        if (await startCirclsCode(phone)) {
          circlsPhoneRef.current = phone;
          confirmationRef.current = null;
          return;
        }
        // A reCAPTCHA token is single-use, so a verifier that has already sent
        // an SMS can't send a second one — which is what a resend asks it to
        // do. Tear down whatever is there and build fresh on every send.
        verifierRef.current?.clear();
        verifierRef.current = new RecaptchaVerifier(auth, RECAPTCHA_CONTAINER_ID, {
          size: 'invisible',
        });
        try {
          confirmationRef.current = await signInWithPhoneNumber(auth, phone, verifierRef.current);
          circlsPhoneRef.current = null;
        } catch (err) {
          // A failed send can leave the widget unusable — reset so the next
          // "Send code" gets a fresh verifier.
          verifierRef.current?.clear();
          verifierRef.current = null;
          throw err;
        }
      },
      async confirmOtp(code) {
        const circlsPhone = circlsPhoneRef.current;
        if (circlsPhone) {
          const { customToken } = await apiFetch<{ customToken: string }>('/v1/auth/phone/verify', {
            method: 'POST',
            body: JSON.stringify({ phone: circlsPhone, code: code.trim() }),
          });
          const cred = await signInWithCustomToken(auth, customToken);
          circlsPhoneRef.current = null;
          recordLogin();
          return cred.user;
        }
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
        circlsPhoneRef.current = null;
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
