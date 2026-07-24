'use client';

import { useState } from 'react';
import { consumerEventUrl } from '@/lib/consumer_links';
import type { EventStatus, EventVisibility } from '@/lib/api/types';

/**
 * The event's consumer (circls.app) link with a copy button — the sharing
 * surface for private-link (unlisted) events, but handy for every event. The
 * link only resolves once the event is published, so pre-publish states get a
 * caption saying so.
 */
export function EventShareLink({
  eventId,
  status,
  visibility,
}: {
  eventId: string;
  status: EventStatus;
  visibility: EventVisibility;
}) {
  const [copied, setCopied] = useState(false);
  const url = consumerEventUrl(eventId);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions/http) — the URL is selectable text.
    }
  }

  const caption =
    status !== 'published'
      ? 'This link goes live once the event is approved and published.'
      : visibility === 'unlisted'
        ? 'This event is hidden from circls.app listings — only people with this link can find it.'
        : visibility === 'access_code'
          ? 'Send this link along with your access code — tickets stay locked until it’s entered.'
          : 'Anyone can also find this event by browsing circls.app.';

  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Event link</dt>
      <dd className="mt-1 flex flex-wrap items-center gap-2">
        <code className="select-all break-all rounded bg-slate-50 px-2 py-1 text-xs text-slate-700">
          {url}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
        <span className="basis-full text-xs text-slate-400">{caption}</span>
      </dd>
    </div>
  );
}
