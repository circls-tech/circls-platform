'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from '@/lib/firebase/client';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from '@/lib/api/client';

interface InviteMeta {
  tenantName: string;
  role: 'owner' | 'manager' | 'staff' | 'readonly';
  email: string;
  inviterEmail: string | null;
  expiresAt: string;
}

interface AcceptResult {
  role: string;
  alreadyMember: boolean;
  roleChanged: boolean;
  previousRole: string | null;
  tenantName: string;
}

/**
 * Modes for the accept page:
 *  - detecting   : waiting on auth state + account-existence lookup
 *  - loggedIn    : a session for this exact email is already active → one-click accept
 *  - mismatch    : signed in as a *different* email than the invite
 *  - login       : email already has a Circls account → ask for password to sign in
 *  - signup      : brand-new email → ask them to set a password
 */
type Mode = 'detecting' | 'loggedIn' | 'mismatch' | 'login' | 'signup';

function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect password for this account. Try again or reset your password.';
    case 'auth/weak-password':
      return 'Password is too weak — use at least 8 characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    default:
      return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
  }
}

export default function AcceptInvitePage() {
  const { token } = useParams() as { token: string };
  const router = useRouter();
  const { user, loading: authLoading, signOut } = useAuth();

  const [meta, setMeta] = useState<InviteMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('detecting');
  const [result, setResult] = useState<AcceptResult | null>(null);

  // ── Load the invitation metadata ──
  useEffect(() => {
    apiFetch<InviteMeta>(`/v1/invitations/lookup?token=${encodeURIComponent(token)}`)
      .then(setMeta)
      .catch((err) => setError(err instanceof Error ? err.message : 'Lookup failed'));
  }, [token]);

  // ── Decide whether to ask for sign up, log in, or accept directly ──
  useEffect(() => {
    if (!meta || authLoading) return;
    const inviteEmail = meta.email.toLowerCase();

    if (user?.email) {
      setMode(user.email.toLowerCase() === inviteEmail ? 'loggedIn' : 'mismatch');
      return;
    }

    // Not signed in — does an account already exist for this email? If sign-in
    // methods come back non-empty, route them to log in instead of sign up.
    // (Email-enumeration protection can hide this; the signup path falls back
    // to login on `auth/email-already-in-use`, so we stay correct either way.)
    let cancelled = false;
    fetchSignInMethodsForEmail(auth, meta.email)
      .then((methods) => {
        if (!cancelled) setMode(methods.length > 0 ? 'login' : 'signup');
      })
      .catch(() => {
        if (!cancelled) setMode('signup');
      });
    return () => {
      cancelled = true;
    };
  }, [meta, user, authLoading]);

  async function acceptWithToken(firebaseIdToken: string) {
    const res = await apiFetch<AcceptResult>(
      `/v1/invitations/${encodeURIComponent(token)}/accept`,
      { method: 'POST', body: JSON.stringify({ firebaseIdToken }) },
    );
    // Already a member and nothing changed → show an outcome screen rather than
    // dropping them into the dashboard as if they'd just joined.
    if (res.alreadyMember && !res.roleChanged) {
      setResult(res);
      return;
    }
    if (res.roleChanged) {
      setResult(res);
      return;
    }
    router.replace('/dashboard');
  }

  // New account: create it, then accept. If the email turns out to already
  // exist, switch to login mode and let them try again with their password.
  async function handleSignup(e: FormEvent) {
    e.preventDefault();
    if (!meta) return;
    setBusy(true);
    setError(null);
    try {
      let cred;
      try {
        cred = await createUserWithEmailAndPassword(auth, meta.email, password);
      } catch (err) {
        const code = (err as { code?: string } | undefined)?.code ?? '';
        if (code === 'auth/email-already-in-use') {
          setMode('login');
          setError('You already have a Circls account — enter your password to log in and accept.');
          return;
        }
        throw err;
      }
      await acceptWithToken(await cred.user.getIdToken());
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Existing account: sign in, then accept.
  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    if (!meta) return;
    setBusy(true);
    setError(null);
    try {
      const cred = await signInWithEmailAndPassword(auth, meta.email, password);
      await acceptWithToken(await cred.user.getIdToken());
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Already signed in as the invited email: accept with the live session.
  async function handleLoggedInAccept() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await acceptWithToken(await user.getIdToken());
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Signed in as the wrong account: sign out and re-detect.
  async function handleSwitchAccount() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      setMode('detecting');
    } finally {
      setBusy(false);
    }
  }

  // ── Invitation could not be loaded ──
  if (error && !meta) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-3 p-6">
        <h1 className="text-2xl font-semibold">Invitation not found</h1>
        <p className="text-sm text-slate-600">
          The link may have expired or been revoked. Ask your team admin to send a fresh invitation.
        </p>
      </main>
    );
  }

  if (!meta) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </main>
    );
  }

  // ── Outcome screen (already a member / role bumped) ──
  if (result) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
        {result.roleChanged ? (
          <>
            <h1 className="text-2xl font-semibold">Role updated</h1>
            <p className="text-sm text-slate-600">
              You were already a member of <strong>{result.tenantName}</strong>. Your role has been
              upgraded from <strong>{result.previousRole}</strong> to <strong>{result.role}</strong>.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">You&apos;re already a member</h1>
            <p className="text-sm text-slate-600">
              You&apos;re already part of <strong>{result.tenantName}</strong> as{' '}
              <strong>{result.role}</strong>. There&apos;s nothing to accept — this invite has been
              closed out.
            </p>
          </>
        )}
        <Link
          href="/dashboard"
          className="rounded bg-blue-600 px-4 py-2 text-center text-white"
        >
          Go to dashboard
        </Link>
      </main>
    );
  }

  const invitedAs = (
    <>
      You&apos;ve been invited to <strong>{meta.tenantName}</strong> as <strong>{meta.role}</strong>
      {meta.inviterEmail ? ` by ${meta.inviterEmail}` : ''}.
    </>
  );

  // ── Still resolving which form to show ──
  if (mode === 'detecting') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </main>
    );
  }

  // ── Signed in as the wrong account ──
  if (mode === 'mismatch') {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-semibold">Join {meta.tenantName}</h1>
        <p className="text-sm text-slate-600">{invitedAs}</p>
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This invitation is for <strong>{meta.email}</strong>, but you&apos;re signed in as{' '}
          <strong>{user?.email}</strong>. Switch accounts to accept it.
        </p>
        <button
          onClick={handleSwitchAccount}
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Switching…' : `Switch to ${meta.email}`}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </main>
    );
  }

  // ── Already signed in as the invited email ──
  if (mode === 'loggedIn') {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-semibold">Join {meta.tenantName}</h1>
        <p className="text-sm text-slate-600">{invitedAs}</p>
        <p className="text-sm text-slate-500">
          You&apos;re signed in as <strong>{meta.email}</strong>.
        </p>
        <button
          onClick={handleLoggedInAccept}
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Accepting…' : 'Accept invitation'}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </main>
    );
  }

  // ── Login or signup form ──
  const isLogin = mode === 'login';
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Join {meta.tenantName}</h1>
      <p className="text-sm text-slate-600">
        {invitedAs}{' '}
        {isLogin
          ? 'Log in to your Circls account to accept.'
          : 'Set a password to create your account and accept.'}
      </p>
      <form onSubmit={isLogin ? handleLogin : handleSignup} className="flex flex-col gap-3">
        <label htmlFor="email" className="text-sm font-medium">Email</label>
        <input
          id="email"
          type="email"
          value={meta.email}
          disabled
          className="rounded border border-gray-300 bg-slate-50 px-3 py-2 text-slate-500"
        />
        <label htmlFor="password" className="text-sm font-medium">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={isLogin ? 'current-password' : 'new-password'}
          required
          minLength={8}
          className="rounded border border-gray-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Accepting…' : isLogin ? 'Log in & accept' : 'Accept invitation'}
        </button>
      </form>
      {isLogin && (
        <Link href="/forgot-password" className="text-center text-sm text-blue-700 hover:underline">
          Forgot password?
        </Link>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
