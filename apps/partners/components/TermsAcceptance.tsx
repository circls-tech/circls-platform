'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  TERMS_COUNTRY_OPTIONS,
  type TermsCountry,
  termsRegionForCountry,
} from '@/lib/terms/constants';
import { termsMarkdownForRegion } from '@/lib/terms/content';

/** Scrollable rendering of the regional Terms document. */
export function TermsDocument({ country }: { country: TermsCountry }) {
  return (
    <div className="max-h-64 overflow-y-auto rounded-[var(--radius)] border border-slate-200 bg-slate-50 p-4">
      <article className="prose prose-sm prose-slate max-w-none prose-headings:font-semibold prose-h1:text-base prose-h2:mt-4 prose-h2:text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {termsMarkdownForRegion(termsRegionForCountry(country))}
        </ReactMarkdown>
      </article>
    </div>
  );
}

/**
 * Country picker + regional Terms document + explicit consent checkbox, shared
 * by onboarding Step 1 (new orgs) and the TermsGate (existing orgs).
 */
export function TermsAcceptance({
  country,
  onCountryChange,
  agreed,
  onAgreedChange,
}: {
  country: TermsCountry;
  onCountryChange: (c: TermsCountry) => void;
  agreed: boolean;
  onAgreedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Where is your organisation based?
        </label>
        <select
          value={country}
          onChange={(e) => onCountryChange(e.target.value as TermsCountry)}
          className="w-full rounded-[var(--radius)] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 transition-colors hover:border-slate-300"
        >
          {TERMS_COUNTRY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <p className="text-xs text-slate-500">
          This picks the Terms &amp; Conditions that apply to your organisation and the currency
          your customers pay in.
        </p>
      </div>

      <TermsDocument country={country} />

      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => onAgreedChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
        />
        <span>
          I am authorised to act for this organisation and accept the{' '}
          <a
            href={`/terms?region=${termsRegionForCountry(country).toLowerCase()}`}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand-600 underline-offset-2 hover:underline"
          >
            Partner Terms &amp; Conditions
          </a>{' '}
          on its behalf.
        </span>
      </label>
    </div>
  );
}
