-- D-116: an owner can keep one contributor's guild card from listing the account. Every existing
-- link stays listed (false).
ALTER TABLE "account_links" ADD COLUMN "hidden_from_card" boolean DEFAULT false NOT NULL;
