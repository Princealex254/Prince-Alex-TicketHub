-- ============================================================================
--  Prince Alex TicketHub - Digital Organizer Agreement & Platform Fees
--  Migration 0008
--  ----------------------------------------------------------------------------
--  Adds the four tables the mandatory organizer agreement system needs:
--
--    1. platform_agreements      one row per agreement VERSION (draft / active /
--                                superseded / archived). Exactly one ACTIVE row
--                                is allowed at a time. A version that has been
--                                activated is never edited again: commercial
--                                changes are made by creating a new version.
--    2. organizer_agreements     the signature record: an immutable snapshot of
--                                the agreement text AND the fee configuration the
--                                organizer accepted, plus the UTC signing time,
--                                the agreement reference and the optional
--                                document hash. UNIQUE(organizer_id,
--                                agreement_id) makes a second signature for the
--                                same version impossible, while still allowing
--                                the same organizer to accept a NEWER version.
--    3. agreement_invitations    single-use, organizer-specific, agreement-
--                                specific signing invitations. Only the SHA-256
--                                hash of the token is stored - never the token.
--    4. agreement_audit_log      append-only trail of agreement events. Written
--                                only by the Worker; no organizer route can
--                                update or delete a row.
--
--  events.agreement_id / events.agreement_version record which agreement version
--  governed an event when it was published, so already-published events keep the
--  terms they were published under and a later version cannot retroactively
--  change them.
--
--  MONEY: the platform commission and payment-processing fee terms are stored and
--  shown here, but this migration changes NO price, order or payment row.
--  Existing orders keep their original amounts.
--
--  Apply (local) : wrangler d1 execute princealextickethub --file=./migrations/0008_organizer_agreements.sql
--  Apply (remote): wrangler d1 execute princealextickethub --file=./migrations/0008_organizer_agreements.sql --remote
--  Every statement is idempotent, so re-running it is safe.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------ platform_agreements --
CREATE TABLE IF NOT EXISTS platform_agreements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    version         TEXT NOT NULL UNIQUE,             -- "1.0", "1.1", "2.0" ...
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,                    -- full agreement text (plain text/markdown)
    summary         TEXT,                             -- one-line change note for the activation email
    fee_config_json TEXT NOT NULL DEFAULT '{}',       -- the commercial terms of this version
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','superseded','archived')),
    effective_date  TEXT,                             -- YYYY-MM-DD the version takes effect
    content_hash    TEXT,                             -- sha256(version|title|content|fee_config)
    created_by      INTEGER,
    activated_by    INTEGER,
    activated_at    TEXT,
    archived_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by)   REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (activated_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_agreements_status  ON platform_agreements(status);
CREATE INDEX IF NOT EXISTS idx_platform_agreements_version ON platform_agreements(version);
/* The business rule "only one active version" is enforced by the Worker inside a
   single batch, and backed by this partial unique index so two concurrent
   activations cannot both win. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_agreements_one_active
    ON platform_agreements(status) WHERE status = 'active';

-- ---------------------------------------------------- agreement_invitations --
-- Created BEFORE organizer_agreements, which references it.
CREATE TABLE IF NOT EXISTS agreement_invitations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT NOT NULL UNIQUE,                -- sha256 of the raw token; the token is never stored
    organizer_id INTEGER NOT NULL,
    user_id      INTEGER,
    agreement_id INTEGER NOT NULL,
    email        TEXT,                                -- the address the link was sent to
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','used','expired','revoked')),
    issued_by    INTEGER,                             -- users.id of whoever triggered the invitation
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,                       -- UTC
    used_at      TEXT,
    FOREIGN KEY (organizer_id) REFERENCES organizers(id) ON DELETE CASCADE,
    FOREIGN KEY (agreement_id) REFERENCES platform_agreements(id),
    FOREIGN KEY (user_id)      REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (issued_by)    REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_agreement_invitations_org       ON agreement_invitations(organizer_id, agreement_id, status);
CREATE INDEX IF NOT EXISTS idx_agreement_invitations_agreement ON agreement_invitations(agreement_id);
CREATE INDEX IF NOT EXISTS idx_agreement_invitations_expires   ON agreement_invitations(expires_at);

-- ----------------------------------------------------- organizer_agreements --
CREATE TABLE IF NOT EXISTS organizer_agreements (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id              INTEGER NOT NULL,
    user_id                   INTEGER,                        -- the authenticated account that signed
    agreement_id              INTEGER NOT NULL,
    agreement_version         TEXT NOT NULL,
    signatory_name            TEXT NOT NULL,                  -- full legal name typed by the signatory
    signatory_email           TEXT NOT NULL,                  -- verified organizer email (Firebase/D1)
    signatory_role            TEXT,                           -- stated capacity, e.g. "Director"
    status                    TEXT NOT NULL DEFAULT 'accepted'
                              CHECK (status IN ('accepted','revoked')),
    accepted_at               TEXT NOT NULL,                  -- UTC signing instant
    content_snapshot          TEXT NOT NULL,                  -- EXACT agreement text accepted
    fee_snapshot_json         TEXT NOT NULL DEFAULT '{}',      -- EXACT fee configuration accepted
    reference                 TEXT NOT NULL UNIQUE,           -- human-readable agreement reference
    verification_method       TEXT NOT NULL DEFAULT 'firebase_authenticated_email_and_single_use_token',
    evidence_json             TEXT,                           -- hashed IP, user agent, invitation id
    invitation_id             INTEGER,
    document_key              TEXT,                           -- R2 object key of the generated document
    document_sha256           TEXT,                           -- tamper-evident hash of that document
    confirmation_email_status TEXT,                           -- queued | sent | failed | duplicate
    revoked_at                TEXT,
    revoked_by                INTEGER,
    revoke_reason             TEXT,
    created_at                TEXT NOT NULL DEFAULT (datetime('now')),
    /* One signature per organizer per agreement VERSION. Accepting a newer
       version inserts a new row, so history is preserved. */
    UNIQUE (organizer_id, agreement_id),
    FOREIGN KEY (organizer_id)  REFERENCES organizers(id) ON DELETE CASCADE,
    FOREIGN KEY (agreement_id)  REFERENCES platform_agreements(id),
    FOREIGN KEY (invitation_id) REFERENCES agreement_invitations(id),
    FOREIGN KEY (user_id)       REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (revoked_by)    REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_organizer_agreements_org       ON organizer_agreements(organizer_id, status);
CREATE INDEX IF NOT EXISTS idx_organizer_agreements_agreement ON organizer_agreements(agreement_id, status);
CREATE INDEX IF NOT EXISTS idx_organizer_agreements_reference ON organizer_agreements(reference);

-- ------------------------------------------------------- agreement_audit_log --
CREATE TABLE IF NOT EXISTS agreement_audit_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    action            TEXT NOT NULL,        -- agreement_created | agreement_updated | agreement_activated |
                                            -- agreement_archived | invitation_issued | agreement_viewed |
                                            -- agreement_signed | document_generated | document_downloaded |
                                            -- agreement_update_requested
    agreement_id      INTEGER,
    agreement_version TEXT,
    organizer_id      INTEGER,              -- the organizer concerned (NULL for platform-wide events)
    actor_user_id     INTEGER,              -- who did it (owner or organizer)
    actor_role        TEXT,                 -- owner | organizer | system
    subject_user_id   INTEGER,              -- whose data was touched, when different from the actor
    detail_json       TEXT,                 -- small, non-sensitive metadata
    ip_hash           TEXT,                 -- HMAC of the client IP, never the raw address
    user_agent        TEXT,                 -- truncated user agent, for evidentiary purposes only
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agreement_audit_agreement ON agreement_audit_log(agreement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agreement_audit_org        ON agreement_audit_log(organizer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agreement_audit_action     ON agreement_audit_log(action, created_at);

-- ------------------------------------------------------- events: governing ---
-- Which agreement version governed this event when it was published. NULL for
-- events published before the agreement system existed: those keep running on
-- their original terms and are only re-checked when they are republished.
ALTER TABLE events ADD COLUMN agreement_id INTEGER;
ALTER TABLE events ADD COLUMN agreement_version TEXT;
