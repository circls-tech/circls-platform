-- Circls super admins: chosen members of the Circls team who may open any
-- partner organisation in the partner portal, without joining it. Only
-- meaningful on the Circls (platform) tenant's rows; platform Owners set it.
ALTER TABLE "tenant_members" ADD COLUMN IF NOT EXISTS "super_admin" boolean DEFAULT false NOT NULL;
