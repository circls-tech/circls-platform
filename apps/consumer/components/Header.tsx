'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button } from '@/lib/ui';

export function Header() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();

  return (
    <header className="border-b border-[#e5e7eb] bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <Link href="/" className="text-lg font-semibold text-brand-700">
          Circls
        </Link>
        <nav className="flex items-center gap-2">
          {loading ? null : user ? (
            <>
              <Link href="/me/bookings">
                <Button variant="ghost" size="sm">My bookings</Button>
              </Link>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  await signOut();
                  router.replace('/');
                }}
              >
                Sign out
              </Button>
            </>
          ) : (
            <Link href="/login">
              <Button variant="primary" size="sm">Sign in</Button>
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
