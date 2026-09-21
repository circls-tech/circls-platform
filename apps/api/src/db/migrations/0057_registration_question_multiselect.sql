-- Registration questions gain a third answer type, 'multiselect': the consumer
-- ticks any number of the question's options ('select' stays "exactly one").
-- Answers keep their shape — one text row per question per booking — with the
-- chosen options stored joined by ", " in option order, so the registrations
-- table, the CSV export and the consumer's booking page render them unchanged.
-- No backfill: every existing row is 'text' or 'select' and passes the new CHECK.

ALTER TABLE "event_registration_questions" DROP CONSTRAINT "event_registration_questions_type_chk";
--> statement-breakpoint
ALTER TABLE "event_registration_questions"
  ADD CONSTRAINT "event_registration_questions_type_chk" CHECK ("type" IN ('text', 'select', 'multiselect'));
