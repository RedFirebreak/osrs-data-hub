-- D-124: the bank value the plugin sends when the bank is opened or closed, and the part of a
-- day's wealth that is the bank. Null until an account's plugin first sends one.
ALTER TABLE "latest_state" ADD COLUMN "bank_value" bigint;--> statement-breakpoint
ALTER TABLE "latest_state" ADD COLUMN "bank_value_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wealth_daily" ADD COLUMN "bank_value" bigint;