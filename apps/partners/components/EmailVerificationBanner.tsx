'use client';
import { useEffect, useState } from 'react';
import { type User } from 'firebase/auth';
import { apiFetch } from '@/lib/api/client';
import { sendVerificationEmail, useAuth } from '@/lib/firebase/auth_context';

/** Reloads the user; when now verified, refreshes the token and lets the API backfill the email. */
async function syncVerified(user: User): Promise<boolean> {
  await user.reload();
  if (!user.emailVerified) return false;
  // Fresh token now carries email_verified; this request lets the API
  // backfill users.email.
  await user.getIdToken(true);
  await apiFetch('/v1/me').catch(() => {});
  return true;
}

/**
 * Shown while the signed-in account's email is unverified. The API refuses to
 * trust (or store) an unverified email, so until the user clicks the Firebase
 * link their `users.email` stays empty — invites can't find them by email and
 * their member entry shows no address. Returning to the tab (or "I've
 * verified") reloads the Firebase user, forces a fresh ID token, and pings
 * /v1/me so the backend backfills the now-verified email onto their row.
 */
export function EmailVerificationBanner() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = !!user?.email && !user.emailVerified && !done;

  // Users verify in another tab and come back; pick that up without making
  // them find "I've verified" (otherwise they re-click a spent link).
  useEffect(() => {
    if (!pending || !user) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      syncVerified(user)
        .then((ok) => ok && setDone(true))
        .catch(() => {});
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [pending, user]);

  if (!pending || !user) return null;

  async function resend() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await sendVerificationEmail(user);
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
      if (await syncVerified(user)) {
        setDone(true);
      } else {
        setError('Still unverified — open the link in the newest email.');
      }
    } catch {
      setError('Could not check — try again in a minute.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900">
      <span>
        Please verify your email — we sent a link to <span className="font-medium">{user.email}</span> (check
        your spam folder too). Only the newest email&apos;s link works. Until then it can&apos;t be shown to your team or used to find your account.
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
