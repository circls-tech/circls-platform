'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading) return <div className="p-8 text-gray-500">Loading…</div>;
  if (!user) return null;

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
        <nav className="flex gap-4 text-sm">
          <Link href="/dashboard" className="font-medium">
            Dashboard
          </Link>
        </nav>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          Sign out
        </button>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}
