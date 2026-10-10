-- D-109: an account's Metrics goals (a target level, XP or kill count), the one table Metrics adds;
-- everything else it shows is read from the tables the hub already keeps (D-106).
CREATE TABLE "account_goals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" integer NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"value" bigint NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_goals_kind_chk" CHECK ("account_goals"."kind" IN ('level', 'xp', 'kc')),
	CONSTRAINT "account_goals_value_chk" CHECK ("account_goals"."value" > 0)
);
--> statement-breakpoint
ALTER TABLE "account_goals" ADD CONSTRAINT "account_goals_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_goals" ADD CONSTRAINT "account_goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_goals_target_uidx" ON "account_goals" USING btree ("account_id","kind","target");--> statement-breakpoint
CREATE INDEX "account_goals_created_by_idx" ON "account_goals" USING btree ("created_by");