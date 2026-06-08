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

type Mode = 'detecting' | 'loggedIn' | 'mismatch' | 'login' | 'signup';

function authErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect password for this account. Please try again.';
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

  useEffect(() => {
    apiFetch<InviteMeta>(`/v1/invitations/lookup?token=${encodeURIComponent(token)}`)
      .then(setMeta)
      .catch((err) => setError(err instanceof Error ? err.message : 'Lookup failed'));
  }, [token]);

  useEffect(() => {
    if (!meta || authLoading) return;
    const inviteEmail = meta.email.toLowerCase();

    if (user?.email) {
      setMode(user.email.toLowerCase() === inviteEmail ? 'loggedIn' : 'mismatch');
      return;
    }

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
    // Accepting may have promoted our email to verified server-side (the invite
    // token proved ownership). Refresh the local session so the next requests
    // carry the updated claim. Best-effort — membership is already granted.
    try {
      await auth.currentUser?.reload();
      await auth.currentUser?.getIdToken(true);
    } catch {
      /* token refreshes within the hour regardless */
    }
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

  if (error && !meta) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-3 p-6">
        <h1 className="text-2xl font-semibold">Invitation not found</h1>
        <p className="text-sm text-slate-600">
          The link may have expired or been revoked.
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
              <strong>{result.role}</strong>. There&apos;s nothing to accept.
            </p>
          </>
        )}
        <Link href="/dashboard" className="rounded bg-blue-600 px-4 py-2 text-center text-white">
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

  if (mode === 'detecting') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </main>
    );
  }

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
        <input
          type="email"
          value={meta.email}
          disabled
          className="rounded border border-gray-300 bg-slate-50 px-3 py-2 text-slate-500"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={isLogin ? 'current-password' : 'new-password'}
          required
          minLength={8}
          className="rounded border border-gray-300 px-3 py-2"
          placeholder={isLogin ? 'Password' : 'New password'}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Accepting…' : isLogin ? 'Log in & accept' : 'Accept invitation'}
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
