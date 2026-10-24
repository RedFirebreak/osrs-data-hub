-- D-119: the prayers that are on, as the plugin sends them since PR #49. Null until an account's
-- plugin first sends them.
ALTER TABLE "latest_state" ADD COLUMN "active_prayers" text[];--> statement-breakpoint
ALTER TABLE "latest_state" ADD COLUMN "active_prayers_updated_at" timestamp with time zone;
