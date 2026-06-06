'use client';
import { type FormEvent, useState, useMemo } from 'react';
import Link from 'next/link';
import { useSubmitSupportIssue } from '@/lib/api/queries';
import { HELP_ARTICLES } from '@/lib/help/articles';
import { Button, Card } from '@/lib/ui';

// ── Article data ──────────────────────────────────────────────────────────────
// Article metadata lives in lib/help/articles.ts (single source of truth) and the
// full body of each article lives in content/help/<slug>.md.

const ARTICLES = [...HELP_ARTICLES].sort((a, b) => a.order - b.order);

// ── Raise an Issue Form ───────────────────────────────────────────────────────

function RaiseIssueForm() {
  const [message, setMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitIssue = useSubmitSupportIssue();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (message.trim().length < 10) {
      setError('Please describe the issue in at least 10 characters.');
      return;
    }
    try {
      await submitIssue.mutateAsync(message.trim());
      setSubmitted(true);
      setMessage('');
    } catch {
      setError('Uh-oh, we encountered an issue. We will resolve this very quickly.');
    }
  }

  if (submitted) {
    return (
      <div className="rounded-[var(--radius)] border border-green-200 bg-green-50 p-4">
        <p className="text-sm font-medium text-green-800">Issue submitted!</p>
        <p className="mt-1 text-sm text-green-700">
          We've received your report. Our team will look into it and update you shortly.
        </p>
        <button
          type="button"
          onClick={() => setSubmitted(false)}
          className="mt-3 text-xs text-green-700 underline underline-offset-2 hover:text-green-900"
        >
          Submit another issue
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Describe what happened and what you were trying to do…"
        rows={4}
        className="w-full resize-none rounded-[var(--radius)] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-400"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">
          Your account ID and timestamp are attached automatically.
        </p>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={submitIssue.isPending}
          disabled={message.trim().length < 10}
        >
          Submit issue
        </Button>
      </div>
    </form>
  );
}

// ── Help Page ─────────────────────────────────────────────────────────────────

export default function HelpPage() {
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'articles' | 'raise-issue'>('articles');

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return ARTICLES;
    return ARTICLES.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.summary.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
    );
  }, [search]);

  const quickArticles = ARTICLES.filter((a) => a.quickLink);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-[#0f172a]">Help Centre</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Guides, articles, and support for the circls Partner Portal.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#e5e7eb]">
        {(['articles', 'raise-issue'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={[
              'px-4 py-2 text-sm font-medium transition-colors',
              activeTab === tab
                ? 'border-b-2 border-brand-600 text-brand-600'
                : 'text-slate-500 hover:text-slate-700',
            ].join(' ')}
          >
            {tab === 'articles' ? 'Articles' : 'Raise an issue'}
          </button>
        ))}
      </div>

      {activeTab === 'articles' && (
        <div className="flex flex-col gap-6">
          {/* Quick access */}
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
              Quick access
            </h2>
            <div className="grid gap-3 sm:grid-cols-3">
              {quickArticles.map((a) => (
                <Link key={a.slug} href={`/help/${a.slug}`} className="group">
                  <Card className="flex h-full flex-col gap-2 transition-colors group-hover:border-brand-300">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-brand-600">
                      {a.category}
                    </span>
                    <p className="text-sm font-medium text-slate-900 group-hover:text-brand-700">
                      {a.title}
                    </p>
                    <p className="text-xs text-slate-500 line-clamp-2">{a.summary}</p>
                  </Card>
                </Link>
              ))}
            </div>
          </section>

          {/* Search */}
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
              All articles
            </h2>
            <div className="relative">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="search"
                placeholder="Search articles…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-[var(--radius)] border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-400 focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>

            {filtered.length === 0 ? (
              <p className="text-sm text-slate-500">No articles match your search.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {filtered.map((a) => (
                  <Link
                    key={a.slug}
                    href={`/help/${a.slug}`}
                    className="group flex flex-col gap-1 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-3 transition-colors hover:border-brand-300 hover:bg-slate-50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-brand-600">
                        {a.category}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-slate-900 group-hover:text-brand-700">
                      {a.title}
                    </p>
                    <p className="text-xs text-slate-500">{a.summary}</p>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {activeTab === 'raise-issue' && (
        <div className="flex flex-col gap-4 max-w-xl">
          <Card title="Raise an issue">
            <div className="flex flex-col gap-4">
              <p className="text-sm text-slate-600">
                Encountered a bug or something not working as expected? Describe it below and our team will investigate. Your account details and timestamp are attached automatically.
              </p>
              <RaiseIssueForm />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
