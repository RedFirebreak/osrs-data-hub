-- D-105: the official hiscores of each account (account_hiscores), the change log of activity
-- scores (activity_scores) and the XP samples the hiscores filled in (hiscore_xp_fills), written by
-- the worker's sync-hiscores job; and the hiscores sharing category.
-- No account is pinned to private for it: the data is public on the hiscores, and nothing the hub
-- showed before becomes visible.
CREATE TABLE "account_hiscores" (
	"account_id" integer PRIMARY KEY NOT NULL,
	"lookup_name" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"fetched_at" timestamp with time zone,
	"main" jsonb,
	"mode_table" jsonb,
	CONSTRAINT "account_hiscores_mode_chk" CHECK ("account_hiscores"."mode" IN ('regular', 'ironman', 'hardcore_ironman', 'ultimate_ironman')),
	CONSTRAINT "account_hiscores_status_chk" CHECK ("account_hiscores"."status" IN ('ok', 'not_found', 'mismatch'))
);
--> statement-breakpoint
CREATE TABLE "activity_scores" (
	"account_id" integer NOT NULL,
	"activity" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"score" integer NOT NULL,
	"baseline" boolean NOT NULL,
	CONSTRAINT "activity_scores_pk" PRIMARY KEY("account_id","activity","read_at")
);
--> statement-breakpoint
CREATE TABLE "hiscore_xp_fills" (
	"account_id" integer NOT NULL,
	"skill_id" smallint NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"xp" bigint NOT NULL,
	CONSTRAINT "hiscore_xp_fills_pk" PRIMARY KEY("account_id","skill_id","bucket")
);
--> statement-breakpoint
ALTER TABLE "account_share_grants" DROP CONSTRAINT "account_share_grants_category_chk";--> statement-breakpoint
ALTER TABLE "account_sharing" DROP CONSTRAINT "account_sharing_category_chk";--> statement-breakpoint
ALTER TABLE "account_hiscores" ADD CONSTRAINT "account_hiscores_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_scores" ADD CONSTRAINT "activity_scores_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiscore_xp_fills" ADD CONSTRAINT "hiscore_xp_fills_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_share_grants" ADD CONSTRAINT "account_share_grants_category_chk" CHECK ("account_share_grants"."category" IN ('stats', 'events', 'activity', 'location_live', 'location_history', 'equipment', 'inventory', 'hiscores'));--> statement-breakpoint
ALTER TABLE "account_sharing" ADD CONSTRAINT "account_sharing_category_chk" CHECK ("account_sharing"."category" IN ('stats', 'events', 'activity', 'location_live', 'location_history', 'equipment', 'inventory', 'hiscores'));