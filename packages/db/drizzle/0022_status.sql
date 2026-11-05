-- D-143: run energy, special attack, poison, the wilderness level and the running effects the plugin
-- sends since PR #54 (after 1.6.3). Null until an account's plugin first sends them.
ALTER TABLE "latest_state" ADD COLUMN "status" jsonb;--> statement-breakpoint
ALTER TABLE "latest_state" ADD COLUMN "status_updated_at" timestamp with time zone;