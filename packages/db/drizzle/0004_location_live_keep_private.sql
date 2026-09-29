-- D-82: the default audience of location_live becomes 'guild' (packages/core DEFAULT_AUDIENCE). A
-- missing account_sharing row means the default, so without this every existing account whose owner
-- never changed the setting would start sharing its live location with the guild. Pin those
-- accounts to what they had ('private'); only accounts first seen after this migration get the new
-- default. Owners can change it on the account page as before.
INSERT INTO account_sharing (account_id, category, audience)
SELECT id, 'location_live', 'private' FROM osrs_accounts
ON CONFLICT (account_id, category) DO NOTHING;
