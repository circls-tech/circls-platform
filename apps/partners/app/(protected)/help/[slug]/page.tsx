import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HELP_ARTICLES, getArticleMeta } from '@/lib/help/articles';
import { getArticleBody } from '@/lib/help/content';

// Pre-render every known article at build time.
export function generateStaticParams() {
  return HELP_ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta = getArticleMeta(slug);
  return { title: meta ? `${meta.title} · Help Centre` : 'Help Centre' };
}

export default async function HelpArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const meta = getArticleMeta(slug);
  const body = await getArticleBody(slug);
  if (!meta || body == null) notFound();

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb */}
      <Link
        href="/help"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-brand-600"
      >
        <span aria-hidden="true">←</span> Back to Help Centre
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-brand-600">
          {meta.category}
        </span>
        <h1 className="text-2xl font-semibold text-[#0f172a]">{meta.title}</h1>
        <p className="text-sm text-slate-500">{meta.summary}</p>
      </div>

      {/* Body */}
      <article className="prose prose-slate max-w-3xl prose-headings:scroll-mt-20 prose-headings:font-semibold prose-h2:mt-8 prose-h2:text-lg prose-h3:text-base prose-a:text-brand-600 prose-a:no-underline hover:prose-a:underline prose-code:rounded prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none prose-pre:bg-slate-900 prose-table:text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </article>

      {/* Footer */}
      <div className="mt-2 flex flex-col gap-3 border-t border-[#e5e7eb] pt-6">
        <p className="text-sm text-slate-500">
          Didn&apos;t find what you need?{' '}
          <Link href="/help" className="text-brand-600 hover:underline">
            Raise an issue
          </Link>{' '}
          from the Help Centre and our team will help.
        </p>
      </div>
    </div>
  );
}
