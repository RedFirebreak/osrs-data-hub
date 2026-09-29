CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"toasts_enabled" boolean DEFAULT true NOT NULL,
	"toast_types" text[],
	"toast_min_loot_value" bigint DEFAULT 0 NOT NULL,
	"toast_own_accounts_only" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"discord_id" text,
	"nickname" text,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"grace_until" timestamp with time zone,
	"offboard_reason" text,
	"last_verified_at" timestamp with time zone,
	"verify_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"label" text,
	"token_hash" text NOT NULL,
	"plugin_version" text,
	"outdated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"first_data_at" timestamp with time zone,
	"last_ip" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"user_id" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"device_id" uuid,
	"last_outdated_attempt_at" timestamp with time zone,
	"last_outdated_version" text
);
--> statement-breakpoint
CREATE TABLE "account_links" (
	"account_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'contributor' NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"blocked_at" timestamp with time zone,
	CONSTRAINT "account_links_pk" PRIMARY KEY("account_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "account_names" (
	"account_id" integer NOT NULL,
	"name" text NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_names_pk" PRIMARY KEY("account_id","name")
);
--> statement-breakpoint
CREATE TABLE "account_share_grants" (
	"account_id" integer NOT NULL,
	"category" text NOT NULL,
	"grantee_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_share_grants_pk" PRIMARY KEY("account_id","category","grantee_user_id")
);
--> statement-breakpoint
CREATE TABLE "account_sharing" (
	"account_id" integer NOT NULL,
	"category" text NOT NULL,
	"audience" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_sharing_pk" PRIMARY KEY("account_id","category")
);
--> statement-breakpoint
CREATE TABLE "device_accounts" (
	"device_id" uuid NOT NULL,
	"account_id" integer NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_accounts_pk" PRIMARY KEY("device_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "latest_state" (
	"account_id" integer PRIMARY KEY NOT NULL,
	"source_device_id" uuid,
	"source_ts" timestamp with time zone,
	"last_seen" timestamp with time zone NOT NULL,
	"last_device_id" uuid,
	"game_state" text,
	"tick_delay" integer,
	"world" integer,
	"world_types" text[],
	"special_world" boolean DEFAULT false NOT NULL,
	"world_updated_at" timestamp with time zone,
	"hp_current" smallint,
	"hp_max" smallint,
	"health_updated_at" timestamp with time zone,
	"prayer_current" smallint,
	"prayer_max" smallint,
	"prayer_updated_at" timestamp with time zone,
	"spellbook_id" smallint,
	"spellbook" text,
	"spellbook_updated_at" timestamp with time zone,
	"location" jsonb,
	"location_updated_at" timestamp with time zone,
	"skills" jsonb,
	"skills_updated_at" timestamp with time zone,
	"inventory" jsonb,
	"inventory_updated_at" timestamp with time zone,
	"equipment" jsonb,
	"equipment_updated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "osrs_accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "osrs_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"account_hash" text NOT NULL,
	"current_name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"account_type" smallint,
	"owner_user_id" text,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "osrs_accounts_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "osrs_accounts_account_hash_unique" UNIQUE("account_hash")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" smallint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "skills_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 32767 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"kind" text DEFAULT 'plugin' NOT NULL,
	"sort_order" smallint DEFAULT 1000 NOT NULL,
	CONSTRAINT "skills_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "equipment_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "equipment_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" integer NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"equipment" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"plugin_event_id" text NOT NULL,
	"sub_index" smallint DEFAULT 0 NOT NULL,
	"account_id" integer NOT NULL,
	"device_id" uuid,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"inserted_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"value_gp" bigint,
	"item_id" integer,
	"npc_id" integer,
	"skill" text,
	"level" smallint,
	"tier" text,
	"points" smallint,
	"special_world" boolean DEFAULT false NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" integer NOT NULL,
	"device_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"worlds" integer[] DEFAULT '{}'::integer[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wealth_daily" (
	"account_id" integer NOT NULL,
	"day" date NOT NULL,
	"last_value" bigint NOT NULL,
	"max_value" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wealth_daily_pk" PRIMARY KEY("account_id","day")
);
--> statement-breakpoint
CREATE TABLE "location_samples" (
	"account_id" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"plane" smallint NOT NULL,
	"world" integer,
	"on_boat" boolean DEFAULT false NOT NULL,
	CONSTRAINT "location_samples_account_ts_uq" UNIQUE("account_id","ts")
);
--> statement-breakpoint
CREATE TABLE "raw_payloads" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"device_id" uuid,
	"account_id" integer,
	"status" smallint,
	"plugin_version" text,
	"meta" jsonb,
	"body" text NOT NULL,
	CONSTRAINT "raw_payloads_pk" PRIMARY KEY("id","received_at")
);
--> statement-breakpoint
CREATE TABLE "xp_samples" (
	"account_id" integer NOT NULL,
	"skill_id" smallint NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"xp" bigint NOT NULL,
	"level" smallint NOT NULL,
	CONSTRAINT "xp_samples_pk" PRIMARY KEY("account_id","skill_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"categories" text[] NOT NULL,
	"account_scope" text DEFAULT 'all_visible' NOT NULL,
	"account_ids" integer[],
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "hub_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_links" ADD CONSTRAINT "account_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_names" ADD CONSTRAINT "account_names_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_share_grants" ADD CONSTRAINT "account_share_grants_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_share_grants" ADD CONSTRAINT "account_share_grants_grantee_user_id_users_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_sharing" ADD CONSTRAINT "account_sharing_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_accounts" ADD CONSTRAINT "device_accounts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_accounts" ADD CONSTRAINT "device_accounts_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "latest_state" ADD CONSTRAINT "latest_state_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "latest_state" ADD CONSTRAINT "latest_state_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "latest_state" ADD CONSTRAINT "latest_state_last_device_id_devices_id_fk" FOREIGN KEY ("last_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "osrs_accounts" ADD CONSTRAINT "osrs_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_changes" ADD CONSTRAINT "equipment_changes_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_sessions" ADD CONSTRAINT "play_sessions_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_sessions" ADD CONSTRAINT "play_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wealth_daily" ADD CONSTRAINT "wealth_daily_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_samples" ADD CONSTRAINT "location_samples_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_samples" ADD CONSTRAINT "xp_samples_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_uidx" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_token_hash_uidx" ON "devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_codes_active_code_uidx" ON "pairing_codes" USING btree ("code") WHERE "pairing_codes"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "pairing_codes_user_idx" ON "pairing_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_links_user_idx" ON "account_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_share_grants_grantee_idx" ON "account_share_grants" USING btree ("grantee_user_id");--> statement-breakpoint
CREATE INDEX "device_accounts_account_idx" ON "device_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "osrs_accounts_name_normalized_idx" ON "osrs_accounts" USING btree ("name_normalized");--> statement-breakpoint
CREATE INDEX "osrs_accounts_owner_idx" ON "osrs_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "equipment_changes_account_idx" ON "equipment_changes" USING btree ("account_id","changed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "events_dedupe_uidx" ON "events" USING btree ("account_id","plugin_event_id","sub_index");--> statement-breakpoint
CREATE UNIQUE INDEX "events_seq_uidx" ON "events" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "events_account_occurred_idx" ON "events" USING btree ("account_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_type_occurred_idx" ON "events" USING btree ("type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "play_sessions_open_uidx" ON "play_sessions" USING btree ("account_id") WHERE "play_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "play_sessions_account_started_idx" ON "play_sessions" USING btree ("account_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "location_samples_ts_idx" ON "location_samples" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "raw_payloads_received_at_idx" ON "raw_payloads" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "raw_payloads_device_idx" ON "raw_payloads" USING btree ("device_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "xp_samples_bucket_idx" ON "xp_samples" USING btree ("bucket" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uidx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_user_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at" DESC NULLS LAST);