'use client';
import { useState } from 'react';
import { sendEmailVerification } from 'firebase/auth';
import { apiFetch } from '@/lib/api/client';
import { useAuth } from '@/lib/firebase/auth_context';

/**
 * Shown while the signed-in account's email is unverified. The API refuses to
 * trust (or store) an unverified email, so until the user clicks the Firebase
 * link their `users.email` stays empty — invites can't find them by email and
 * their member entry shows no address. "I've verified" reloads the Firebase
 * user, forces a fresh ID token, and pings /v1/me so the backend backfills the
 * now-verified email onto their row.
 */
export function EmailVerificationBanner() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user?.email || user.emailVerified || done) return null;

  async function resend() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await sendEmailVerification(user);
      setSent(true);
    } catch {
      setError('Could not send the email — try again in a minute.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmVerified() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await user.reload();
      if (!user.emailVerified) {
        setError('Still unverified — click the link in the email first.');
        return;
      }
      // Fresh token now carries email_verified; this request lets the API
      // backfill users.email.
      await user.getIdToken(true);
      await apiFetch('/v1/me').catch(() => {});
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      <span>
        Please verify your email — we sent a link to <span className="font-medium">{user.email}</span>.
        Until then it can&apos;t be shown to your team or used to find your account.
      </span>
      <button
        type="button"
        onClick={() => void resend()}
        disabled={busy || sent}
        className="font-medium underline disabled:opacity-50"
      >
        {sent ? 'Email sent' : 'Resend email'}
      </button>
      <button
        type="button"
        onClick={() => void confirmVerified()}
        disabled={busy}
        className="font-medium underline disabled:opacity-50"
      >
        I&apos;ve verified
      </button>
      {error && <span className="text-red-700">{error}</span>}
    </div>
  );
}
