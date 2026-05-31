'use client';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { BrandMark } from '@/components/BrandMark';

export default function LoginPage() {
  const { signInWithEmail } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithEmail(email, password);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div className="flex items-center gap-3">
        <BrandMark className="h-11 w-11" />
        <h1 className="text-2xl font-bold tracking-tight">circls Admin</h1>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className="rounded border border-gray-300 px-3 py-2"
          required
        />
        <label className="text-sm font-medium" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="rounded border border-gray-300 px-3 py-2"
          required
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
