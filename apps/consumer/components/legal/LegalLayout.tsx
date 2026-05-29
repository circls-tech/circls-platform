import Link from 'next/link';
import { Header } from '@/components/Header';
import type { LegalDoc } from '@/lib/legal/types';

const TABS: { slug: string; label: string }[] = [
  { slug: 'privacy', label: 'Privacy' },
  { slug: 'terms', label: 'Terms' },
  { slug: 'refund', label: 'Refund' },
];

export function LegalLayout({ doc }: { doc: LegalDoc }) {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-[11px] font-bold uppercase tracking-widest text-gold-600">
          Circls · Gibbous Technologies Private Limited
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-ink">{doc.title}</h1>
        <p className="mt-1 text-sm text-text-secondary">Last updated {doc.updated}</p>
        <p className="mt-1 text-sm text-text-secondary">
          Contact: Contact@gibbous.io · Jurisdiction: Nagpur, Maharashtra, India
        </p>

        <nav aria-label="Policies" className="mt-5 flex gap-2">
          {TABS.map((t) => (
            <Link
              key={t.slug}
              href={`/${t.slug}`}
              aria-current={t.slug === doc.slug ? 'page' : undefined}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                t.slug === doc.slug ? 'bg-ink text-white' : 'bg-gold-100 text-gold-text hover:bg-gold-100/70'
              }`}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        <div className="mt-6 rounded-card border border-border bg-white p-5 text-sm leading-relaxed text-ink/90">
          {doc.intro}
        </div>

        <div className="mt-8 space-y-8">
          {doc.sections.map((s, i) => (
            <section key={i}>
              {s.group && (
                <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-text-muted">{s.group}</p>
              )}
              <h2 className="font-display text-lg font-semibold text-ink">
                {s.number != null ? `${s.number}. ` : ''}{s.title}
              </h2>
              {s.paragraphs.map((p, j) => (
                <p key={j} className="mt-2 text-sm leading-relaxed text-ink/90">{p}</p>
              ))}
              {s.bullets && s.bullets.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink/90">
                  {s.bullets.map((b, k) => <li key={k}>{b}</li>)}
                </ul>
              )}
            </section>
          ))}
        </div>

        <div className="mt-10 rounded-card border border-border bg-gold-100/40 p-5 text-sm text-ink">
          Questions? Reach us at <a className="font-semibold underline" href="mailto:Contact@gibbous.io">Contact@gibbous.io</a>.
        </div>
      </main>
    </div>
  );
}
