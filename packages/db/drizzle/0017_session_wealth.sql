-- D-125: each play session's carried wealth and bank value at its first and latest payload, so a
-- session can say what it gained or lost. Null on sessions from before.
ALTER TABLE "play_sessions" ADD COLUMN "carried_start" bigint;--> statement-breakpoint
ALTER TABLE "play_sessions" ADD COLUMN "carried_end" bigint;--> statement-breakpoint
ALTER TABLE "play_sessions" ADD COLUMN "bank_start" bigint;--> statement-breakpoint
ALTER TABLE "play_sessions" ADD COLUMN "bank_end" bigint;