-- Migration 003: NDPA privacy compliance tables
--
-- Implements technical controls for Nigeria Data Protection Act 2023 (NDPA):
--
--   privacy_notices        — versioned privacy notices; current version is the
--                            row with the highest version number.
--   user_consent_versions  — maps each user account to the privacy notice
--                            version they accepted and when.
--   dsar_requests          — Data Subject Access Request log; tracks lifecycle
--                            from submission → export_ready / erased / rejected.
--   privacy_audit_log      — append-only log of every PII field read by a
--                            non-owner actor (admin, KYC provider, internal
--                            service).  Written by services/privacyAudit/.
--
-- Retention policy (CBN Circular BSD/DIR/GEN/LAB/07/014 + NDPA s.37):
--   * Transaction records: 5 years minimum (CBN requirement).
--   * PII-only records: erasable after account closure unless bound to a live
--     transaction within the 5-year window.
--   * Audit log rows: 7 years (AML / CBN examination evidence).
--
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- privacy_notices
-- ---------------------------------------------------------------------------
-- Stores the full text (or a canonical URL) of each published version of the
-- AfroPay Privacy Notice.  The highest `version` integer is always current.
--
-- effective_date  — when this version became legally binding.
-- notice_text     — full plain-text or HTML of the notice at this version.
-- summary_of_changes — human-readable delta from the previous version; shown
--                       to users when prompting re-consent.
CREATE TABLE IF NOT EXISTS privacy_notices (
    id                  BIGSERIAL   PRIMARY KEY,
    version             INTEGER     NOT NULL UNIQUE CHECK (version > 0),
    effective_date      DATE        NOT NULL,
    notice_text         TEXT        NOT NULL,
    summary_of_changes  TEXT        NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by          TEXT        NOT NULL  -- operator who published this version
);

CREATE INDEX IF NOT EXISTS privacy_notices_version ON privacy_notices (version DESC);

-- ---------------------------------------------------------------------------
-- user_consent_versions
-- ---------------------------------------------------------------------------
-- Records the privacy-notice version each user has explicitly accepted.
-- One row per (account, version) — a user re-consenting to a new version
-- inserts a new row rather than updating the old one, preserving history.
--
-- account         — Stellar G… address (matches Customer.account in api/store).
-- notice_version  — FK to privacy_notices.version.
-- consented_at    — timestamp of the user's explicit acceptance action.
-- ip_address      — client IP at the moment of consent (evidence for NDPC).
-- user_agent      — browser / app user-agent string at consent time.
CREATE TABLE IF NOT EXISTS user_consent_versions (
    id              BIGSERIAL   PRIMARY KEY,
    account         TEXT        NOT NULL,
    notice_version  INTEGER     NOT NULL REFERENCES privacy_notices (version),
    consented_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address      TEXT,
    user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS ucv_account          ON user_consent_versions (account);
CREATE INDEX IF NOT EXISTS ucv_notice_version   ON user_consent_versions (notice_version);
-- Fast lookup: "has this account consented to the current version?"
CREATE UNIQUE INDEX IF NOT EXISTS ucv_account_version
    ON user_consent_versions (account, notice_version);

-- ---------------------------------------------------------------------------
-- dsar_requests
-- ---------------------------------------------------------------------------
-- Lifecycle of Data Subject Access Requests (DSAR) and Right-to-Erasure
-- requests submitted via POST /api/v1/privacy/dsar and /erasure.
--
-- request_type:
--   'export'   — DSAR: the user wants a copy of all their PII.
--   'erasure'  — Right to erasure: replace PII with pseudonyms.
--
-- status:
--   'pending'        — received, not yet processed.
--   'processing'     — async job is running (large data sets).
--   'export_ready'   — export file is available at export_url.
--   'erased'         — pseudonymization complete.
--   'rejected'       — request rejected (regulatory retention carve-out applies).
--   'failed'         — processing error; ops team notified.
--
-- regulatory_hold: TRUE when CBN 5-year retention prevents full erasure.
--   The erasure still proceeds for non-retained fields; this flag documents
--   that transaction amounts/timestamps were preserved per CBN requirement.
CREATE TABLE IF NOT EXISTS dsar_requests (
    id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    account             TEXT        NOT NULL,
    request_type        TEXT        NOT NULL CHECK (request_type IN ('export', 'erasure')),
    status              TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processing', 'export_ready',
                                              'erased', 'rejected', 'failed')),
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    requester_ip        TEXT,
    requester_user_agent TEXT,
    -- For export requests: signed URL or file path of the generated export.
    export_url          TEXT,
    export_expires_at   TIMESTAMPTZ,
    -- For erasure requests: documents what was retained and why.
    regulatory_hold     BOOLEAN     NOT NULL DEFAULT FALSE,
    regulatory_hold_reason TEXT,
    -- Internal: which operator / service processed the request.
    processed_by        TEXT,
    notes               TEXT
);

CREATE INDEX IF NOT EXISTS dsar_account       ON dsar_requests (account);
CREATE INDEX IF NOT EXISTS dsar_status        ON dsar_requests (status);
CREATE INDEX IF NOT EXISTS dsar_requested_at  ON dsar_requests (requested_at DESC);

-- ---------------------------------------------------------------------------
-- privacy_audit_log
-- ---------------------------------------------------------------------------
-- Append-only log.  A row is inserted whenever a non-owner actor reads one
-- or more PII fields belonging to a data subject.
--
-- actor_id     — identity of the accessor: Stellar account, admin email, or
--                service name (e.g. "kyc-provider:smile-identity").
-- actor_type   — 'admin' | 'service' | 'anchor' | 'operator'
-- subject_account — Stellar G… address of the data subject whose PII was read.
-- fields_accessed — comma-separated list of PII field names that were read
--                   (e.g. "first_name,last_name,bvn").
-- purpose      — business purpose code: 'kyc_review' | 'aml_screening' |
--                'dsar_export' | 'support_lookup' | 'fraud_investigation' |
--                'reconciliation'
-- legal_basis  — NDPA legal basis: 'legitimate_interest' | 'legal_obligation' |
--                'consent' | 'vital_interest' | 'public_task'
-- request_id   — optional correlation to a dsar_requests.id or other request.
-- source_ip    — IP address of the actor's request (for admin panel access).
-- metadata     — arbitrary JSON: e.g. { "query_ref": "TKT-1234" }.
--
-- IMPORTANT: this table must NEVER be updated or deleted from application code.
-- Deletion is only permitted by a privileged DB maintenance role after the
-- 7-year retention window, per AML audit requirements.
CREATE TABLE IF NOT EXISTS privacy_audit_log (
    id              BIGSERIAL   PRIMARY KEY,
    actor_id        TEXT        NOT NULL,
    actor_type      TEXT        NOT NULL
                        CHECK (actor_type IN ('admin', 'service', 'anchor', 'operator')),
    subject_account TEXT        NOT NULL,
    fields_accessed TEXT        NOT NULL,   -- comma-separated field names
    purpose         TEXT        NOT NULL
                        CHECK (purpose IN ('kyc_review', 'aml_screening', 'dsar_export',
                                           'support_lookup', 'fraud_investigation',
                                           'reconciliation')),
    legal_basis     TEXT        NOT NULL
                        CHECK (legal_basis IN ('legitimate_interest', 'legal_obligation',
                                               'consent', 'vital_interest', 'public_task')),
    request_id      TEXT,       -- optional correlation ID
    source_ip       TEXT,
    metadata        JSONB       NOT NULL DEFAULT '{}',
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes optimised for NDPC audit queries and DSAR lookups
CREATE INDEX IF NOT EXISTS pal_subject_account ON privacy_audit_log (subject_account);
CREATE INDEX IF NOT EXISTS pal_actor_id        ON privacy_audit_log (actor_id);
CREATE INDEX IF NOT EXISTS pal_occurred_at     ON privacy_audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS pal_purpose         ON privacy_audit_log (purpose);

-- Revoke DELETE / UPDATE from the application role so accidental or malicious
-- log tampering is rejected at the DB layer.
-- (Uncomment and adapt to your DB role names before running in production.)
-- REVOKE DELETE, UPDATE, TRUNCATE ON privacy_audit_log FROM afropay_app;
-- GRANT INSERT, SELECT ON privacy_audit_log TO afropay_app;
