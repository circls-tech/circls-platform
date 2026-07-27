import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';
import { termsMarkdownForRegion } from '@/lib/terms/content';
import { BrandMark } from '@/lib/ui';

export const metadata = { title: 'Partner Terms & Conditions · circls' };

/**
 * Public Terms & Conditions viewer. `?region=us` shows the US document;
 * anything else (including no param) shows the India document. Linked from
 * onboarding, the acceptance gate, and the Help Centre.
 */
export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ region?: string }>;
}) {
  const { region } = await searchParams;
  const activeRegion = region?.toLowerCase() === 'us' ? 'US' : 'IN';

  return (
    <div className="min-h-screen bg-[#f8fafc]">
      <header className="border-b border-[#e5e7eb] bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-6">
          <BrandMark className="h-7 w-7" />
          <span className="text-lg font-bold tracking-tight text-slate-900">circls</span>
        </div>
      </header>

      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
        <div className="flex items-center gap-2">
          <Link
            href="/terms"
            className={[
              'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              activeRegion === 'IN'
                ? 'bg-brand-600 text-slate-900'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:text-slate-900',
            ].join(' ')}
          >
            India
          </Link>
          <Link
            href="/terms?region=us"
            className={[
              'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              activeRegion === 'US'
                ? 'bg-brand-600 text-slate-900'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:text-slate-900',
            ].join(' ')}
          >
            United States
          </Link>
        </div>

        <article className="prose prose-slate max-w-none rounded-[var(--radius)] border border-slate-200 bg-white p-8 prose-headings:font-semibold prose-h1:text-xl prose-h2:text-base">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {termsMarkdownForRegion(activeRegion)}
          </ReactMarkdown>
        </article>
      </main>
    </div>
  );
}
