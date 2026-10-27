-- Share booking: a customer hands individual QR tickets of an event or court
-- booking to friends through a link. One row per shared ticket; the friend who
-- accepts it sees the booking in their My Bookings with that ticket only.
-- An accepted share is final; an unaccepted one can be withdrawn.

CREATE TABLE "booking_ticket_shares" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "booking_id" uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
  "qr_ticket_id" uuid NOT NULL REFERENCES "qr_tickets"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "shared_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "claimed_by_user_id" uuid REFERENCES "users"("id"),
  "claimed_at" timestamp with time zone,
  "withdrawn_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "booking_ticket_shares_claimed_chk"
    CHECK ((claimed_by_user_id IS NULL) = (claimed_at IS NULL)),
  CONSTRAINT "booking_ticket_shares_withdrawn_unclaimed_chk"
    CHECK (withdrawn_at IS NULL OR claimed_at IS NULL)
);
--> statement-breakpoint
-- At most one live share per ticket.
CREATE UNIQUE INDEX "booking_ticket_shares_live_ticket_uq"
  ON "booking_ticket_shares" ("qr_ticket_id") WHERE "withdrawn_at" IS NULL;
--> statement-breakpoint
-- "Bookings shared with me" (My Bookings and the booking page).
CREATE INDEX "booking_ticket_shares_claimed_by_idx"
  ON "booking_ticket_shares" ("claimed_by_user_id", "booking_id") WHERE "claimed_by_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "booking_ticket_shares_booking_idx" ON "booking_ticket_shares" ("booking_id");
