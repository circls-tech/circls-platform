'use client';
import { useEffect, useRef, useState } from 'react';
import { useActivity } from '@/lib/activity/ActivityProvider';
import type { WishlistItemType } from '@/lib/api/types';
import { shareLink, type ShareOutcome } from '@/lib/share';

/**
 * One share tap, as ShareButton and InviteButton both make it: share (or copy)
 * through shareLink, log it as a `share` of the listing with its outcome, and
 * remember how it went for the button to show.
 *
 * `last` is the latest tap's outcome until the next tap; `recent` is true for
 * `noteMs` after it, for notes that should fade. A tap while the previous one
 * is still waiting on the share sheet is ignored: the sheet would refuse it,
 * and the clipboard fallback would then log a copy that never happened.
 */
export function useShareTap(noteMs: number) {
  const [last, setLast] = useState<ShareOutcome | null>(null);
  const [recent, setRecent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const activity = useActivity();

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function tap(
    data: { title: string; text?: string; url: string },
    item: { itemType: WishlistItemType; itemId: string; props?: Record<string, unknown> },
    opts?: { copy?: string },
  ): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const outcome = await shareLink(data, opts);
      activity.log('share', { itemType: item.itemType, itemId: item.itemId, props: { ...item.props, outcome } });
      setLast(outcome);
      setRecent(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setRecent(false), noteMs);
    } finally {
      inFlight.current = false;
    }
  }

  return { last, recent, tap };
}
