-- D-88: service (integration) keys share api_keys with user keys. `kind` tells them apart, a
-- service key has no user_id (offboarding never revokes it; it counts towards no user's limit) and
-- records who created it; `rate_limit_per_minute` is null for the default of its kind.
ALTER TABLE "api_keys" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "kind" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "rate_limit_per_minute" integer;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_user_check" CHECK (("api_keys"."kind" = 'user') = ("api_keys"."user_id" IS NOT NULL));--> statement-breakpoint
UPDATE "api_keys" SET "created_by_user_id" = "user_id" WHERE "created_by_user_id" IS NULL;
