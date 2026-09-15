'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { beginVisit, recordBack, recordForward } from './history_depth';

/**
 * Keeps the in-app navigation depth in step with the router.
 *
 * Mounted once, at the root, so it sees the whole visit — a BackBar mounting
 * on some inner page can't tell how the visitor got there.
 *
 * Distinguishing a forward move from a back one matters: without it, using
 * Back would *raise* the depth and the next Back would try to step off the
 * front of our own history.
 */
export function NavDepthTracker() {
  const pathname = usePathname();
  // Keyed off the path rather than a mounted-yet flag so React's double-invoked
  // effects in development can't count a phantom navigation.
  const seen = useRef<string | null>(null);
  const cameFromPop = useRef(false);

  useEffect(() => {
    const onPop = () => {
      cameFromPop.current = true;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (seen.current === null) {
      beginVisit();
      seen.current = pathname;
      return;
    }
    if (seen.current === pathname) return;
    seen.current = pathname;

    if (cameFromPop.current) {
      cameFromPop.current = false;
      recordBack();
    } else {
      recordForward();
    }
  }, [pathname]);

  return null;
}
