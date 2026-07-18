// Shared display labels for the questions inbox and thread detail pages.

import type { QuestionCategory, QuestionSubjectType } from '@/lib/api/types';

export const SUBJECT_LABELS: Record<QuestionSubjectType, string> = {
  event:      'Event',
  arena:      'Arena',
  membership: 'Membership',
  general:    'General',
};

/** Short human labels for the Help-interview triage categories. */
export const CATEGORY_LABELS: Record<QuestionCategory, string> = {
  booking_issue:  'Booking issue',
  refund_request: 'Refund request',
  reschedule:     'Reschedule',
  venue_question: 'Venue question',
  payment:        'Payment',
  other:          'Other',
};
