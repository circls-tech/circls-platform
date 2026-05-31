'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button, BrandMark } from '@/lib/ui';

export function Header() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();

  return (
    <header className="bg-ink text-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-xl font-bold tracking-tight text-white">
          <BrandMark className="h-7 w-7" />
          <span>circls</span>
        </Link>
        <nav className="flex items-center gap-2 sm:gap-4">
          <Link href="/venues" className="hidden text-sm text-white/80 hover:text-white sm:inline">Venues</Link>
          <Link href="/events" className="hidden text-sm text-white/80 hover:text-white sm:inline">Events</Link>
          {loading ? null : user ? (
            <>
              <Link href="/me/bookings" className="text-sm text-white/80 hover:text-white">My bookings</Link>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => { await signOut(); router.replace('/'); }}
              >
                Sign out
              </Button>
            </>
          ) : (
            <Link href="/login"><Button variant="accent" size="sm">Sign in</Button></Link>
          )}
        </nav>
      </div>
    </header>
  );
}
