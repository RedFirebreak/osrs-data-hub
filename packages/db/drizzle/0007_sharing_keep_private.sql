-- D-96: location_history, equipment and inventory default to 'guild' too (packages/core
-- DEFAULT_AUDIENCE), so every category is shared with the guild by default. A missing
-- account_sharing row means the default, so without this every existing account whose owner never
-- chose one would start sharing its 30-day trail, gear and inventory with the guild. Pin those
-- accounts to what they had ('private'), as 0004 did for location_live; only accounts first seen
-- after this migration get the new default. An explicit choice is kept. Owners can change it on the
-- account page as before.
INSERT INTO account_sharing (account_id, category, audience)
SELECT a.id, c.category, 'private'
FROM osrs_accounts a
CROSS JOIN (VALUES ('location_history'), ('equipment'), ('inventory')) AS c (category)
ON CONFLICT (account_id, category) DO NOTHING;
