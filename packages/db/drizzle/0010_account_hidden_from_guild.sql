-- D-104: an owner can hide an account from the guild. Every existing account stays shown (false).
ALTER TABLE "osrs_accounts" ADD COLUMN "hidden_from_guild" boolean DEFAULT false NOT NULL;