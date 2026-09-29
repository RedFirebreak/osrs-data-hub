CREATE INDEX "events_device_idx" ON "events" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "play_sessions_device_idx" ON "play_sessions" USING btree ("device_id");