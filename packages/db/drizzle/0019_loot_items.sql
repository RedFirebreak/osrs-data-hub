-- D-136: the items of every loot and PK loot event in a table of their own, and a trigram index over
-- the NPC an event names, for `item=` and `npc=` on /api/v1/events. pg_trgm ships with Postgres and
-- is a trusted extension: the database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "loot_items" (
	"event_seq" bigint NOT NULL,
	"idx" smallint NOT NULL,
	"account_id" integer NOT NULL,
	"item_id" integer,
	"name" text NOT NULL,
	"quantity" integer,
	CONSTRAINT "loot_items_pk" PRIMARY KEY("event_seq","idx")
);
--> statement-breakpoint
ALTER TABLE "loot_items" ADD CONSTRAINT "loot_items_event_seq_events_seq_fk" FOREIGN KEY ("event_seq") REFERENCES "public"."events"("seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loot_items" ADD CONSTRAINT "loot_items_account_id_osrs_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."osrs_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loot_items_name_trgm_idx" ON "loot_items" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "loot_items_account_item_idx" ON "loot_items" USING btree ("account_id","item_id");--> statement-breakpoint
CREATE INDEX "events_npc_name_trgm_idx" ON "events" USING gin (lower(coalesce("data" #>> '{data,source,text}', "data" #>> '{data,killerName}', "data" #>> '{data,name}')) gin_trgm_ops) WHERE "events"."type" in ('loot', 'pk_loot', 'death', 'superior_spawn');--> statement-breakpoint
-- The events stored before this migration, by the rules ingest applies to new ones (lootItemRows in
-- @hub/core): at most the first 64 items, a name trimmed, cut to 100 characters and lower-cased, an
-- id or quantity kept only when it is a whole number below 10^9.
INSERT INTO "loot_items" ("event_seq", "idx", "account_id", "item_id", "name", "quantity")
SELECT e."seq", (i.ord - 1)::smallint, e."account_id",
  CASE WHEN i.item ->> 'id' ~ '^[0-9]{1,9}$' THEN (i.item ->> 'id')::integer END,
  lower(left(btrim(i.item ->> 'name'), 100)),
  CASE WHEN i.item ->> 'quantity' ~ '^[0-9]{1,9}$' THEN (i.item ->> 'quantity')::integer END
FROM "events" e
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(e."data" #> '{data,items}') = 'array' THEN e."data" #> '{data,items}' ELSE '[]'::jsonb END
) WITH ORDINALITY AS i(item, ord)
WHERE e."type" IN ('loot', 'pk_loot') AND i.ord <= 64 AND jsonb_typeof(i.item) = 'object'
  AND jsonb_typeof(i.item -> 'name') = 'string' AND btrim(i.item ->> 'name') <> ''
ON CONFLICT DO NOTHING;