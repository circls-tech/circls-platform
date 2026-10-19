import Link from 'next/link';
import type { ReactNode } from 'react';
import { INK_RAISED } from './Button';

export interface BackLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

/**
 * The page-level "back" control: a raised ink-bordered arrow chip and the
 * destination's name in ink, bold.
 *
 * It replaces the small grey "← Venues" text links, which blended into the
 * page and whose arrow was just another glyph in the sentence. The chip
 * borrows the Button's comic ink-border look, so it reads as something you
 * press, and the visible label says where it lands rather than "Back" — a
 * hidden "Back to" prefix keeps it distinct from the sidebar link of the
 * same name for assistive tech.
 */
export function BackLink({ href, children, className = '' }: BackLinkProps) {
  return (
    <Link
      href={href}
      className={[
        'group inline-flex w-fit items-center gap-2.5 text-sm font-bold text-[#17151D]',
        'hover:underline underline-offset-4',
        className,
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'inline-flex h-8 w-8 items-center justify-center rounded-full bg-white',
          INK_RAISED,
          'transition-transform group-hover:-translate-x-0.5 group-hover:bg-brand-600',
          'group-active:translate-x-0 group-active:shadow-[1px_1px_0_#17151D]',
        ].join(' ')}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 12H5" />
          <path d="m12 19-7-7 7-7" />
        </svg>
      </span>
      <span>
        <span className="sr-only">Back to </span>
        {children}
      </span>
    </Link>
  );
}
