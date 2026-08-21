'use client';

import { Input } from '@/lib/ui';
import type { PostBookingRedirect } from '@/lib/api/types';

/** Longest blurb the API accepts (mirrors MAX_REDIRECT_DESCRIPTION). */
export const MAX_REDIRECT_DESCRIPTION = 500;

/** Config emitted when the toggle is first switched on. */
const BLANK_REDIRECT: PostBookingRedirect = { url: '', description: null, forced: false };

/**
 * Same http(s)-only rule the API enforces, so a bad link is caught in the form
 * instead of coming back as a 400. Anything else (`javascript:`, `mailto:`,
 * a bare "docs.google.com/…") is rejected.
 */
export function isValidRedirectUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw.trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Drop a half-filled draft: an enabled redirect with no URL is the same as no
 * redirect at all, and the API would reject it. Call on submit.
 */
export function redirectToPayload(value: PostBookingRedirect | null): PostBookingRedirect | null {
  if (!value || !value.url.trim()) return null;
  return {
    url: value.url.trim(),
    description: value.description?.trim() ? value.description.trim() : null,
    forced: value.forced,
  };
}

/**
 * Editor for an event's `postBookingRedirect` — the link customers are shown
 * once their booking is confirmed (a Google Form for squad details, a WhatsApp
 * community invite, a waiver). Fully controlled: emits a complete object while
 * on, or `null` when off.
 *
 * Only confirmed bookers ever see the link — it is not part of the public
 * event listing, so a private group invite stays with the people who paid.
 */
export function PostBookingRedirectEditor({
  value,
  onChange,
  disabled,
}: {
  value: PostBookingRedirect | null;
  onChange: (v: PostBookingRedirect | null) => void;
  disabled?: boolean;
}) {
  const enabled = value !== null;
  const cfg = value ?? BLANK_REDIRECT;
  const urlTouched = cfg.url.trim().length > 0;
  const urlInvalid = urlTouched && !isValidRedirectUrl(cfg.url);

  function patch(p: Partial<PostBookingRedirect>) {
    onChange({ ...cfg, ...p });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
          After booking
        </label>
        <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white p-0.5">
          {([false, true] as const).map((on) => (
            <button
              key={String(on)}
              type="button"
              disabled={disabled}
              onClick={() => onChange(on ? cfg : null)}
              className={[
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                enabled === on ? 'bg-[#F9B4D4] text-[#17151D]' : 'text-slate-600 hover:text-slate-900',
              ].join(' ')}
            >
              {on ? 'Send them a link' : 'Nothing'}
            </button>
          ))}
        </div>
        <p className="text-xs text-[#94a3b8]">
          Point confirmed bookers at a next step — a Google Form, your WhatsApp group, a waiver.
          Only people who completed a booking see it, and it stays on their booking page.
        </p>
      </div>

      {enabled && (
        <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3">
          <Input
            label="Link"
            type="url"
            inputMode="url"
            placeholder="https://forms.gle/…"
            value={cfg.url}
            disabled={disabled}
            onChange={(e) => patch({ url: e.target.value })}
            hint="Full address, starting with https://"
            {...(urlInvalid ? { error: 'Enter a full http:// or https:// link' } : {})}
          />

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              What to tell them
            </label>
            <textarea
              value={cfg.description ?? ''}
              disabled={disabled}
              maxLength={MAX_REDIRECT_DESCRIPTION}
              onChange={(e) => patch({ description: e.target.value || null })}
              rows={2}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Fill in your team roster before Friday so we can seed the draw."
            />
            <p className="text-xs text-[#94a3b8]">
              Shown above the link on the confirmation screen. Optional.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={cfg.forced}
                disabled={disabled}
                onChange={(e) => patch({ forced: e.target.checked })}
              />
              Open it for them automatically
            </label>
            <p className="text-xs text-[#94a3b8]">
              {cfg.forced
                ? 'The confirmation screen counts down and opens the link in a new tab. They keep their confirmation on screen, can still skip it, and the link stays on their booking page.'
                : 'The link is offered as a button — customers follow it if they want to.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
