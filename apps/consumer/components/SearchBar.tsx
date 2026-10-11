'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { normaliseQuery, searchHref, type SearchScope } from '@/lib/search';

export function SearchIcon({ className = 'h-[18px] w-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="2.2" />
      <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The search box. Submitting (Enter or the magnifier) opens `/search` for the
 * term; with `onChange` the parent is told every keystroke instead, which the
 * search page uses to update results live. `value` keeps it in step with the
 * URL when the page is navigated from outside (the header, back/forward).
 */
export function SearchBar({
  value,
  onChange,
  scope = 'all',
  autoFocus = false,
  placeholder = 'Search events, venues, memberships…',
  className = '',
}: {
  value?: string;
  onChange?: (value: string) => void;
  scope?: SearchScope;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => {
    if (value !== undefined) setDraft(value);
  }, [value]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = normaliseQuery(draft);
    if (!q) return;
    router.push(searchHref(q, scope));
  }

  return (
    <form role="search" onSubmit={submit} className={`relative ${className}`}>
      <input
        type="search"
        enterKeyHint="search"
        autoFocus={autoFocus}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange?.(e.target.value);
        }}
        placeholder={placeholder}
        aria-label="Search events, venues and memberships"
        className={[
          'w-full rounded-[var(--radius)] border-[2px] border-ink bg-white py-2.5 pl-3.5 pr-12 text-sm',
          'text-ink placeholder:text-text-muted shadow-offset-sm',
          'transition-colors duration-150 focus:border-coral-deep focus:outline-none',
          '[&::-webkit-search-cancel-button]:appearance-none',
        ].join(' ')}
      />
      <button
        type="submit"
        aria-label="Search"
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-[var(--radius)] text-ink hover:text-coral-deep"
      >
        <SearchIcon />
      </button>
    </form>
  );
}
