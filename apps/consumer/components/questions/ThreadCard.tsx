'use client';
import { Badge, type BadgeTone } from '@/lib/ui';
import { formatRelativeTime } from '@/lib/format';
import type { QuestionStatus, QuestionSubjectType, QuestionThreadListRow } from '@/lib/api/types';

/** Consumer-friendly labels for question thread statuses. */
const QUESTION_STATUS_META: Record<QuestionStatus, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'warning' },
  answered: { label: 'Answered', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export function QuestionStatusBadge({ status, className }: { status: QuestionStatus; className?: string }) {
  const meta = QUESTION_STATUS_META[status];
  return <Badge tone={meta.tone} label={meta.label} className={className} />;
}

/** How a thread subject type reads to a consumer (arenas are "courts" app-wide). */
export const SUBJECT_TYPE_LABELS: Record<QuestionSubjectType, string> = {
  event: 'Event',
  arena: 'Court',
  membership: 'Membership',
};

/**
 * One question thread in a list — excerpt, status, reply count, author and
 * relative activity time. Clicking opens the thread's slide-over transcript.
 */
export function ThreadCard({
  row,
  onOpen,
  showSubject = false,
}: {
  row: QuestionThreadListRow;
  onOpen: () => void;
  /** Show the subject name line (only /mine rows carry `subject`). */
  showSubject?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-card border-[2.5px] border-ink bg-white px-4 py-3.5 text-left shadow-offset-sm transition-[transform,box-shadow] duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset"
    >
      {showSubject && row.subject && (
        <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-ink-soft">
          {SUBJECT_TYPE_LABELS[row.subject.type]} · {row.subject.name}
        </p>
      )}
      <p className="text-sm text-ink line-clamp-2">{row.rootBody}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-text-secondary">
        <QuestionStatusBadge status={row.status} />
        {row.visibility === 'private' && <Badge tone="neutral" label="Private" />}
        <span className="font-medium text-ink">{row.authorName}</span>
        <span aria-hidden>·</span>
        <span>{row.replyCount === 1 ? '1 reply' : `${row.replyCount} replies`}</span>
        <span aria-hidden>·</span>
        <span>{formatRelativeTime(row.lastMessageAt)}</span>
      </div>
    </button>
  );
}
