-- D-127: the 5-minute buckets in which a player moved, changed the inventory or changed gear, so they
-- count as active time besides XP and loot. Nothing before this migration has marks.
CREATE TABLE "activity_marks" (
	"account_id" integer NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"kinds" smallint NOT NULL,
	CONSTRAINT "activity_marks_pk" PRIMARY KEY("account_id","bucket")
);
--> statement-breakpoint
ALTER TABLE "activity_marks" ADD CONSTRAINT "activity_marks_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;