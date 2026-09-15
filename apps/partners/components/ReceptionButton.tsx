'use client';

import Link from 'next/link';
import { Button } from '@/lib/ui';

/**
 * The front-desk action — serving someone who is standing in front of you.
 *
 * Deliberately identical on an arena, an event and a plan: reception is one
 * job, so it should be one button wherever staff look for it. The purple is
 * Check-in's colour from the sidebar, the other thing done at a counter.
 *
 * Takes an `href` where reception is a page of its own (an arena's live grid),
 * or an `onClick` where it opens the desk in place (walk-ins on an event or a
 * plan, which live on the page you are already reading).
 */
export function ReceptionButton({
  href,
  onClick,
  disabled,
  label = 'Reception',
}: {
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const button = (
    <Button petal="#CDBBF7" size="sm" onClick={onClick} disabled={disabled}>
      {label}
    </Button>
  );
  return href ? <Link href={href}>{button}</Link> : button;
}
