'use client';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from '@/lib/firebase/client';
import { apiFetch } from '@/lib/api/client';

interface InviteMeta {
  tenantName: string;
  role: 'owner' | 'manager' | 'staff' | 'readonly';
  email: string;
  inviterEmail: string | null;
  expiresAt: string;
}

export default function AcceptInvitePage() {
  const { token } = useParams() as { token: string };
  const router = useRouter();
  const [meta, setMeta] = useState<InviteMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<InviteMeta>(`/v1/invitations/lookup?token=${encodeURIComponent(token)}`)
      .then(setMeta)
      .catch((err) => setError(err instanceof Error ? err.message : 'Lookup failed'));
  }, [token]);

  async function handleAccept(e: FormEvent) {
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
          cred = await signInWithEmailAndPassword(auth, meta.email, password);
        } else {
          throw err;
        }
      }
      const firebaseIdToken = await cred.user.getIdToken();
      await apiFetch(`/v1/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: JSON.stringify({ firebaseIdToken }),
      });
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
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
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Join {meta.tenantName}</h1>
      <p className="text-sm text-slate-600">
        You&apos;ve been invited as <strong>{meta.role}</strong>. Set a password to accept.
      </p>
      <form onSubmit={handleAccept} className="flex flex-col gap-3">
        <input type="email" value={meta.email} disabled className="rounded border border-gray-300 bg-slate-50 px-3 py-2 text-slate-500" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          minLength={8}
          className="rounded border border-gray-300 px-3 py-2"
          placeholder="New password"
        />
        <button type="submit" disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
          {busy ? 'Accepting…' : 'Accept invitation'}
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
