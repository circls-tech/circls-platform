-- Partner-configurable "what to do next" link, shown to the customer once an
-- event booking is confirmed (a Google Form for squad details, a WhatsApp
-- community invite, a waiver to sign). null = nothing to show.
--
-- Shape: {"url": "https://…", "description": "…" | null, "forced": bool}.
-- `forced` only changes the presentation — the confirmation screen counts down
-- and navigates for the customer (with a visible skip) instead of offering a
-- button they may ignore. The URL is restricted to http(s) by the API.

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "post_booking_redirect" jsonb;
