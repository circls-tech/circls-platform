'use client';
import { type FormEvent, useState, useMemo } from 'react';
import { useSubmitSupportIssue } from '@/lib/api/queries';
import { Button, Card } from '@/lib/ui';

// ── Article data ──────────────────────────────────────────────────────────────

const ARTICLES = [
  {
    id: 'onboarding',
    title: 'Getting started: create your organisation and first venue',
    category: 'Setup',
    summary: 'A step-by-step walkthrough of the onboarding wizard — creating an organisation, adding a venue, setting up arenas, and releasing your first slots.',
  },
  {
    id: 'venues',
    title: 'Managing venues and arenas',
    category: 'Venues',
    summary: 'How to add, edit and update your venues and arenas, upload photos, and manage their listing status.',
  },
  {
    id: 'schedule',
    title: 'Setting up schedules and slot pricing',
    category: 'Scheduling',
    summary: 'Use the visual schedule builder to define opening hours, block-out days, slot durations, and per-slot pricing.',
  },
  {
    id: 'bookings',
    title: 'Understanding bookings and cancellations',
    category: 'Bookings',
    summary: 'How to view confirmed bookings, handle cancellations, issue refunds, and manage no-shows.',
  },
  {
    id: 'events',
    title: 'Creating and publishing events',
    category: 'Events',
    summary: 'How to create events tied to your venues, set capacity and pricing, and get them approved for the consumer portal.',
  },
  {
    id: 'memberships',
    title: 'Setting up membership plans',
    category: 'Memberships',
    summary: 'How to create membership plans, define benefits and pricing, and manage active member subscriptions.',
  },
  {
    id: 'team',
    title: 'Inviting and managing team members',
    category: 'Settings',
    summary: 'How to invite colleagues to your organisation, assign roles (owner, manager, staff, read-only), and revoke access.',
  },
  {
    id: 'api-keys',
    title: 'API keys and webhooks',
    category: 'Developer',
    summary: 'How to generate API keys, configure outbound webhooks, and integrate circls with your own systems.',
  },
];

const QUICK_LINKS = ['onboarding', 'schedule', 'bookings'];

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

  const quickArticles = ARTICLES.filter((a) => QUICK_LINKS.includes(a.id));

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
                <Card key={a.id} className="flex flex-col gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-brand-600">
                    {a.category}
                  </span>
                  <p className="text-sm font-medium text-slate-900">{a.title}</p>
                  <p className="text-xs text-slate-500 line-clamp-2">{a.summary}</p>
                </Card>
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
                  <div
                    key={a.id}
                    className="flex flex-col gap-1 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-brand-600">
                        {a.category}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-slate-900">{a.title}</p>
                    <p className="text-xs text-slate-500">{a.summary}</p>
                  </div>
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
