import { pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { users } from './users.js';

export const supportIssueStatus = pgEnum('support_issue_status', [
  'unresolved',
  'in_progress',
  'backlog',
  'resolved',
]);

export const supportIssuePriority = pgEnum('support_issue_priority', [
  'low',
  'medium',
  'high',
]);

export const supportIssues = pgTable('support_issues', {
  id: uuidPk(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  message: text('message').notNull(),
  status: supportIssueStatus('status').notNull().default('unresolved'),
  priority: supportIssuePriority('priority').notNull().default('medium'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type SupportIssue = typeof supportIssues.$inferSelect;
export type NewSupportIssue = typeof supportIssues.$inferInsert;
