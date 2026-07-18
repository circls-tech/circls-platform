'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { EmptyState } from '@/components/EmptyState';
import { ThreadCard } from '@/components/questions/ThreadCard';
import { ThreadView } from '@/components/questions/ThreadView';
import { useMyQuestions } from '@/lib/api/questions';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button } from '@/lib/ui';

export default function MyQuestionsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const questionsQ = useMyQuestions();
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login?redirect=/me/questions');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-3xl px-4 py-8">
          <p className="text-sm text-text-secondary">Loading…</p>
        </main>
      </div>
    );
  }

  const rows = questionsQ.data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 font-display text-4xl font-extrabold text-ink">My questions</h1>

        {questionsQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading your questions…</p>
        ) : questionsQ.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {questionsQ.error instanceof Error
              ? questionsQ.error.message
              : 'Failed to load questions'}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No questions yet"
            body="Ask the organiser anything from an event, court, or membership page — your threads and their replies will show up here."
            action={
              <Link href="/events">
                <Button size="sm">Browse events</Button>
              </Link>
            }
          />
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {rows.map((row) => (
                <ThreadCard
                  key={row.id}
                  row={row}
                  showSubject
                  onOpen={() => setOpenThreadId(row.id)}
                />
              ))}
            </div>
            {questionsQ.hasNextPage && (
              <div className="mt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={questionsQ.isFetchingNextPage}
                  onClick={() => void questionsQ.fetchNextPage()}
                >
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      <ThreadView threadId={openThreadId} onClose={() => setOpenThreadId(null)} />
    </div>
  );
}
