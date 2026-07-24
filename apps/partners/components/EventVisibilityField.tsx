'use client';

import { Input } from '@/lib/ui';
import type { EventVisibility } from '@/lib/api/types';

/**
 * Event visibility control: who can find and enter the event on circls.app.
 * Draft value = the chosen visibility plus the access-code input's string
 * (only meaningful for `access_code`). Convert on submit via
 * {@link visibilityToPayload}.
 */
export interface VisibilityDraft {
  visibility: EventVisibility;
  accessCode: string;
}

export const VISIBILITY_OPTIONS: { value: EventVisibility; label: string; hint: string }[] = [
  {
    value: 'public',
    label: 'Public',
    hint: 'Anyone can find and book this event on circls.app.',
  },
  {
    value: 'unlisted',
    label: 'Private link',
    hint: 'Hidden from circls.app listings — only people you send the event link can see and book it.',
  },
  {
    value: 'access_code',
    label: 'Access code',
    hint: 'Listed on circls.app as invite-only, but tickets stay locked until the customer enters your access code.',
  },
];

/** The create/update payload fields for a draft. Clears the code when it no longer applies. */
export function visibilityToPayload(draft: VisibilityDraft): {
  visibility: EventVisibility;
  accessCode: string | null;
} {
  return {
    visibility: draft.visibility,
    accessCode: draft.visibility === 'access_code' ? draft.accessCode.trim() || null : null,
  };
}

/** Hydrate the draft from an event's saved values (as returned by GET). */
export function visibilityFromApi(ev: {
  visibility: EventVisibility;
  accessCode: string | null;
}): VisibilityDraft {
  return { visibility: ev.visibility, accessCode: ev.accessCode ?? '' };
}

export function emptyVisibility(): VisibilityDraft {
  return { visibility: 'public', accessCode: '' };
}

/** Partner-facing display label for a saved visibility value. */
export function visibilityLabel(visibility: EventVisibility): string {
  return VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.label ?? visibility;
}

/** A short, unambiguous code (no 0/O or 1/I) the partner can still override. */
function generateCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

export function EventVisibilityField({
  value,
  onChange,
  disabled,
}: {
  value: VisibilityDraft;
  onChange: (next: VisibilityDraft) => void;
  disabled?: boolean;
}) {
  const selected = VISIBILITY_OPTIONS.find((o) => o.value === value.visibility)!;
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
        Visibility
      </label>
      <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white p-0.5">
        {VISIBILITY_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...value, visibility: o.value })}
            className={[
              'rounded px-3 py-1.5 text-sm font-medium transition-colors',
              value.visibility === o.value
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900',
            ].join(' ')}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">{selected.hint}</p>

      {value.visibility === 'access_code' && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-56">
            <Input
              label="Access code"
              value={value.accessCode}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, accessCode: e.target.value })}
              placeholder="e.g. CLUB-NIGHT"
              hint="4–64 characters. Not case-sensitive."
            />
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...value, accessCode: generateCode() })}
            className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Generate
          </button>
          <p className="basis-full text-xs text-slate-500">
            Share this code with your invitees — they&apos;ll enter it on the event page to see
            tickets and book.
          </p>
        </div>
      )}
    </div>
  );
}
