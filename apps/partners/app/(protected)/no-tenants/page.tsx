'use client';
import { useAuth } from '@/lib/firebase/auth_context';

export default function NoTenantsPage() {
  const { signOut, user } = useAuth();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">No organizations yet</h1>
      <p className="text-sm text-slate-600">
        You&apos;re signed in as <span className="font-medium">{user?.email}</span>, but you aren&apos;t a member of any team yet. Ask your team admin to send you an invitation.
      </p>
      <button
        type="button"
        onClick={() => void signOut()}
        className="mx-auto rounded border border-gray-300 px-4 py-2 text-sm"
      >
        Sign out
      </button>
    </main>
  );
}
