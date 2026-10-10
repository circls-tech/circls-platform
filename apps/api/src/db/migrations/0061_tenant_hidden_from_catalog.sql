-- Keep an organisation off everything consumers see (organisers directory,
-- its profile, venues, events, memberships, questions, checkout) while it
-- works normally for its own members. For App Review demo and internal test
-- orgs; a platform admin sets it (PATCH /v1/admin/tenants/:id/catalog).
ALTER TABLE "tenants" ADD COLUMN "hidden_from_catalog" boolean DEFAULT false NOT NULL;
