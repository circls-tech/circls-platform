'use client';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';

export default function ForgotPasswordPage() {
  const { sendPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendPasswordReset(email);
      setSent(true);
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code ?? '';
      if (code === 'auth/invalid-email') {
        setError('That email address looks invalid.');
      } else if (code === 'auth/too-many-requests') {
        setError('Too many requests. Please wait a moment and try again.');
      } else if (code === 'auth/network-request-failed') {
        setError('Network error. Check your connection and try again.');
      } else {
        setError('Uh-oh, we encountered an issue. We will resolve this very quickly.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      {sent ? (
        <p className="text-sm text-slate-700">
          If an account exists for that email, a password-reset link is on its way.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label htmlFor="email" className="text-sm font-medium">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="rounded border border-gray-300 px-3 py-2"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
      <Link href="/login" className="text-center text-sm text-blue-700 hover:underline">
        Back to sign in
      </Link>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
