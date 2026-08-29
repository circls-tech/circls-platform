'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { ApiError } from '@/lib/api/client';
import { useDeleteMyAccount } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button, Card, Input } from '@/lib/ui';

/** Typed verbatim to arm the delete button — no accidental taps. */
const CONFIRM_PHRASE = 'DELETE';

/**
 * https://circls.app/account/delete — the account-deletion URL published to
 * Google Play and the App Store, so it must stay reachable while SIGNED OUT
 * (a store reviewer opens it cold). Signed-out visitors get the explanation
 * plus a sign-in link; there is deliberately no auth redirect on this route.
 */
export default function DeleteAccountPage() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const deleteAccount = useDeleteMyAccount();

  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    // The Firebase account is gone server-side; drop the local session too so
    // the app doesn't sit on a token that can no longer be verified.
    await signOut();
    router.replace('/');
  }

  async function onDelete() {
    setError(null);
    try {
      await deleteAccount.mutateAsync();
      await finish();
    } catch (e) {
      // A stale tab whose account is already gone: the Firebase user no longer
      // exists, so the request dies at the API's auth layer with `auth_required`
      // rather than reaching the handler. Either way the session is dead and the
      // work is done — finish the flow instead of showing an error.
      if (e instanceof ApiError && e.code === 'auth_required') {
        await finish();
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not delete your account. Please try again.');
    }
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <BackBar fallbackHref="/me/profile" />
        <h1 className="mb-6 font-display text-4xl font-extrabold text-ink">Delete your account</h1>

        <Card>
          <div className="flex flex-col gap-4 text-sm leading-relaxed text-ink/90">
            <p>Deleting your Circls account is permanent. We cannot undo it.</p>

            <div>
              <p className="font-display text-xs font-bold uppercase tracking-wide text-ink">
                What we delete
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>Your name, phone number, email and interests.</li>
                <li>Your sign-in — you will be signed out everywhere.</li>
                <li>Your activity history and anything you sent to support.</li>
              </ul>
            </div>

            <div>
              <p className="font-display text-xs font-bold uppercase tracking-wide text-ink">
                What we keep
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  Your booking and payment records. Indian tax and accounting law requires us to
                  retain them, and venues need them to settle their payouts.
                </li>
                <li>
                  Questions you posted publicly stay up, but they are no longer linked to you.
                </li>
              </ul>
            </div>

            <p>
              See our <Link href="/privacy" className="font-semibold text-coral-deep underline">Privacy Policy</Link>{' '}
              for how long we keep records, or email{' '}
              <a href="mailto:contact@gibbous.io" className="font-semibold text-coral-deep underline">
                contact@gibbous.io
              </a>{' '}
              with any questions.
            </p>
          </div>
        </Card>

        <div className="mt-6">
          {loading ? (
            <p className="text-sm text-text-secondary">Loading…</p>
          ) : !user ? (
            <Card>
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-ink/90">
                  Sign in with the phone number on the account you want to delete.
                </p>
                <Link href="/login?redirect=/account/delete">
                  <Button>Sign in to delete your account</Button>
                </Link>
              </div>
            </Card>
          ) : (
            <Card>
              <div className="flex flex-col gap-4">
                <Input
                  label={`Type ${CONFIRM_PHRASE} to confirm`}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={CONFIRM_PHRASE}
                  autoComplete="off"
                  disabled={deleteAccount.isPending}
                />
                {error && <p className="text-xs font-semibold text-petal-red">{error}</p>}
                <div>
                  <Button
                    variant="danger"
                    onClick={onDelete}
                    disabled={confirm.trim() !== CONFIRM_PHRASE}
                    loading={deleteAccount.isPending}
                  >
                    Delete my account
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
