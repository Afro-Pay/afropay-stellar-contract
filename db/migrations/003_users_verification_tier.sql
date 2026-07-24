-- Migration 003: users table with KYC verification tier
--
-- Creates the users table keyed on Stellar account address.
-- verification_tier tracks the KYC level required by CBN regulations:
--   none      — no verification performed
--   basic     — partial / low-confidence match (e.g. name only)
--   enhanced  — full BVN match; required for transfers above TRANSFER_LIMIT_NGN
--
-- bvn_hash stores SHA-256(BVN) — the raw BVN is never persisted.
--
-- Columns
-- -------
-- id                   UUID primary key (gen_random_uuid).
-- stellar_account      Stellar G… or M… address — unique per user.
-- verification_tier    KYC level: 'none' | 'basic' | 'enhanced'.
-- bvn_hash             SHA-256 hex digest of the user's BVN (nullable until verified).
-- verified_at          Timestamp of the most recent successful verification.
-- last_checked_at      Timestamp of the most recent verification attempt (any outcome).
-- created_at           Row creation time.
-- updated_at           Last row modification time (updated by application layer).
--
-- Indexes
-- -------
-- users_stellar_account — unique index for fast lookup by Stellar account.
-- users_verification_tier — partial index over non-none tiers for compliance queries.

CREATE TABLE IF NOT EXISTS users (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    stellar_account      TEXT        NOT NULL,
    verification_tier    TEXT        NOT NULL DEFAULT 'none'
                             CHECK (verification_tier IN ('none', 'basic', 'enhanced')),
    bvn_hash             TEXT,
    verified_at          TIMESTAMPTZ,
    last_checked_at      TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_stellar_account
    ON users (stellar_account);

-- Partial index: fast lookup of verified users for compliance reporting.
CREATE INDEX IF NOT EXISTS users_verification_tier_non_none
    ON users (verification_tier)
    WHERE verification_tier <> 'none';

-- ---------------------------------------------------------------------------
-- Trigger: keep updated_at current on every UPDATE (Postgres only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'users_set_updated_at'
    ) THEN
        CREATE TRIGGER users_set_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END;
$$;
