// Shared badge maps + helpers for the Questions list and detail pages.
import type {
  QuestionAuthorKind,
  QuestionStatus,
  QuestionSubjectType,
  QuestionVisibility,
} from '@/lib/api/types';

export const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const STATUS_LABELS: Record<QuestionStatus, string> = {
  open: 'Open',
  answered: 'Answered',
  closed: 'Closed',
};

export const STATUS_COLORS: Record<QuestionStatus, string> = {
  open: 'bg-amber-100 text-amber-800',
  answered: 'bg-green-100 text-green-800',
  closed: 'bg-slate-100 text-slate-700',
};

export const VISIBILITY_LABELS: Record<QuestionVisibility, string> = {
  public: 'Public',
  private: 'Private',
};

export const VISIBILITY_COLORS: Record<QuestionVisibility, string> = {
  public: 'bg-sky-100 text-sky-800',
  private: 'bg-violet-100 text-violet-800',
};

export const SUBJECT_TYPE_LABELS: Record<QuestionSubjectType, string> = {
  event: 'Event',
  arena: 'Arena',
  membership: 'Membership',
};

export const SUBJECT_TYPE_COLORS: Record<QuestionSubjectType, string> = {
  event: 'bg-indigo-100 text-indigo-800',
  arena: 'bg-teal-100 text-teal-800',
  membership: 'bg-rose-100 text-rose-800',
};

export const AUTHOR_KIND_LABELS: Record<QuestionAuthorKind, string> = {
  consumer: 'Consumer',
  org: 'Organizer',
  circls: 'Circls',
};

export const AUTHOR_KIND_COLORS: Record<QuestionAuthorKind, string> = {
  consumer: 'bg-slate-100 text-slate-700',
  org: 'bg-indigo-100 text-indigo-800',
  circls: 'bg-emerald-100 text-emerald-800',
};

export function Badge({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}
