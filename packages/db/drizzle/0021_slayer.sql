-- D-141: the slayer task, points and streaks the plugin sends since PR #52 (after 1.6.2). Null until
-- an account's plugin first sends them.
ALTER TABLE "latest_state" ADD COLUMN "slayer" jsonb;--> statement-breakpoint
ALTER TABLE "latest_state" ADD COLUMN "slayer_updated_at" timestamp with time zone;
