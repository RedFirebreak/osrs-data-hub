-- D-117: Invite a friend. Members invite friends who are not in the Discord guild by username
-- (friend_invites), admins bar usernames (friend_blacklist), users.access says how a user got in
-- (every existing user is a member), and three offboarding reasons for friends.
CREATE TABLE "friend_blacklist" (
	"username" text PRIMARY KEY NOT NULL,
	"discord_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "friend_invites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"username" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_offboard_reason_chk";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "friend_blacklist" ADD CONSTRAINT "friend_blacklist_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_invites" ADD CONSTRAINT "friend_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_invites" ADD CONSTRAINT "friend_invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friend_blacklist_discord_id_idx" ON "friend_blacklist" USING btree ("discord_id");--> statement-breakpoint
CREATE UNIQUE INDEX "friend_invites_username_uidx" ON "friend_invites" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "friend_invites_user_uidx" ON "friend_invites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "friend_invites_invited_by_idx" ON "friend_invites" USING btree ("invited_by_user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_access_chk" CHECK ("users"."access" IN ('member', 'friend'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_offboard_reason_chk" CHECK ("users"."offboard_reason" IS NULL OR "users"."offboard_reason" IN ('left_guild', 'lost_role', 'admin', 'self_delete', 'inviter_left', 'invite_removed', 'blacklisted'));