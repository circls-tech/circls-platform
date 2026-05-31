'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { BrandMark } from '@/lib/ui';

/** Friendly copy for the Firebase signup error codes we expect. */
function signupErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code ?? '';
  switch (code) {
    case 'auth/email-already-in-use':
      return 'An account with this email already exists — sign in instead.';
    case 'auth/invalid-email':
      return 'That email address looks invalid.';
    case 'auth/weak-password':
      return 'Password is too weak — use at least 8 characters.';
    default:
      return err instanceof Error ? err.message : 'Sign-up failed';
  }
}

export default function SignupPage() {
  const { signUpWithEmail } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signUpWithEmail(email, password);
      // New account has no org yet — drop them into the onboarding wizard.
      router.replace('/onboarding');
    } catch (err) {
      setError(signupErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <BrandMark className="h-11 w-11" />
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Create your circls account</h1>
        <p className="text-sm text-slate-500">
          Set up your organisation and list your venues in a few steps.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          className="rounded border border-gray-300 px-3 py-2"
        />
        <label className="text-sm font-medium" htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          minLength={8}
          className="rounded border border-gray-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <Link href="/login" className="text-center text-sm text-blue-700 hover:underline">
        Already have an account? Sign in
      </Link>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
