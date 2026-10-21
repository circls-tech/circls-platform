'use client';

import { savedAgo } from '@/lib/form_autosave';
import type { FormAutosave } from '@/lib/use_form_autosave';

/**
 * Tells the partner the form was filled from what they typed on an earlier
 * visit, with a way back to a blank form. Nothing shows for a fresh form.
 */
export function RestoredFormNotice({
  autosave,
  unkept,
}: {
  autosave: FormAutosave<unknown>;
  /** One sentence on what wasn't kept, for a form with a file picker (files can't be). */
  unkept?: string;
}) {
  if (!autosave.restored || autosave.savedAt === null) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 px-3 py-2 text-sm text-slate-600">
      <span>
        Restored what you typed here {savedAgo(autosave.savedAt)}, kept in this browser until you save.
        {unkept && ` ${unkept}`}
      </span>
      <button
        type="button"
        onClick={autosave.startOver}
        className="font-medium text-slate-800 underline-offset-2 hover:underline"
      >
        Start over
      </button>
    </div>
  );
}
