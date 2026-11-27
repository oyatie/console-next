-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

-- console-gate: audited-table ops_account_holders
CREATE TABLE ops_account_holders (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL,
    designated_by   UUID        NULL,
    designated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at     TIMESTAMPTZ NULL,
    release_reason  TEXT        NULL CHECK (release_reason IS NULL OR char_length(btrim(release_reason)) BETWEEN 1 AND 200),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE,
    CHECK ((released_at IS NULL) = (release_reason IS NULL))
);

CREATE INDEX ops_account_holders_org_user_idx
    ON ops_account_holders (org_id, user_id, designated_at DESC);

ALTER TABLE ops_account_holders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_account_holders FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ops_account_holders
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL ON ops_account_holders FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON ops_account_holders TO console_rt;
GRANT UPDATE (released_at, release_reason) ON ops_account_holders TO console_rt;

COMMENT ON TABLE ops_account_holders IS 'Tenant ops account holder bindings (at least 1, at most 2 active holders per tenant; self-only release).';
COMMENT ON COLUMN ops_account_holders.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN ops_account_holders.id IS 'pd:none — holder binding identifier';
COMMENT ON COLUMN ops_account_holders.user_id IS 'pd:personal — bound ops account holder user id';
COMMENT ON COLUMN ops_account_holders.designated_by IS 'pd:personal — designating ops account holder user id (NULL for initial bootstrap backfill)';
COMMENT ON COLUMN ops_account_holders.designated_at IS 'pd:none — holder designation timestamp';
COMMENT ON COLUMN ops_account_holders.released_at IS 'pd:none — self-release timestamp (NULL while active)';
COMMENT ON COLUMN ops_account_holders.release_reason IS 'pd:none — non-identifying self-release reason code or summary';

-- console-gate: audited-table recovery_contacts
CREATE TABLE recovery_contacts (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL,
    channel         TEXT        NOT NULL CHECK (channel IN ('EMAIL', 'PHONE')),
    masked_value    TEXT        NOT NULL CHECK (char_length(btrim(masked_value)) BETWEEN 3 AND 160),
    alg_id          TEXT        NOT NULL CHECK (alg_id = 'aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp'),
    kek_id          TEXT        NOT NULL CHECK (char_length(btrim(kek_id)) BETWEEN 1 AND 128),
    key_version     INTEGER     NOT NULL DEFAULT 3 CHECK (key_version = 3),
    msg_id          BYTEA       NOT NULL CHECK (octet_length(msg_id) = 32),
    commitment_tag  BYTEA       NOT NULL CHECK (octet_length(commitment_tag) = 32),
    nonce           BYTEA       NOT NULL CHECK (octet_length(nonce) = 12),
    dek_wrapped     BYTEA       NOT NULL CHECK (octet_length(dek_wrapped) BETWEEN 40 AND 256),
    ciphertext      BYTEA       NOT NULL CHECK (octet_length(ciphertext) >= 17),
    notice_version  TEXT        NOT NULL CHECK (char_length(btrim(notice_version)) BETWEEN 1 AND 64),
    confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE,
    CONSTRAINT recovery_contacts_envelope_shape CHECK (
        (key_version = 3
            AND octet_length(nonce) = 12
            AND octet_length(dek_wrapped) BETWEEN 40 AND 256
            AND octet_length(msg_id) = 32
            AND octet_length(commitment_tag) = 32
            AND alg_id = 'aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp') IS TRUE
    )
);

CREATE INDEX recovery_contacts_org_user_idx
    ON recovery_contacts (org_id, user_id);

ALTER TABLE recovery_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON recovery_contacts
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL ON recovery_contacts FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON recovery_contacts TO console_rt;
GRANT UPDATE (channel, masked_value, alg_id, kek_id, key_version, msg_id, commitment_tag, nonce, dek_wrapped, ciphertext, notice_version, confirmed_at, updated_at)
    ON recovery_contacts TO console_rt;

COMMENT ON TABLE recovery_contacts IS 'AWS-ESDK-v2 envelope-encrypted recovery contacts for tenant ops account holders.';
COMMENT ON COLUMN recovery_contacts.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN recovery_contacts.id IS 'pd:none — recovery contact row identifier';
COMMENT ON COLUMN recovery_contacts.user_id IS 'pd:personal — ops account holder user id';
COMMENT ON COLUMN recovery_contacts.channel IS 'pd:none — delivery channel (EMAIL or PHONE)';
COMMENT ON COLUMN recovery_contacts.masked_value IS 'pd:personal — UI-safe masked contact display string';
COMMENT ON COLUMN recovery_contacts.alg_id IS 'pd:none — AEAD suite identifier (aws-esdk-v2-aes256-gcm-hkdf-sha256-kwp)';
COMMENT ON COLUMN recovery_contacts.kek_id IS 'pd:none — wrapping KEK identifier';
COMMENT ON COLUMN recovery_contacts.key_version IS 'pd:none — envelope format version (3)';
COMMENT ON COLUMN recovery_contacts.msg_id IS 'pd:none — 256-bit HKDF per-message random salt';
COMMENT ON COLUMN recovery_contacts.commitment_tag IS 'pd:none — 256-bit key commitment tag';
COMMENT ON COLUMN recovery_contacts.nonce IS 'pd:none — 96-bit AES-256-GCM nonce';
COMMENT ON COLUMN recovery_contacts.dek_wrapped IS 'pd:none — KWP-wrapped 256-bit message DEK';
COMMENT ON COLUMN recovery_contacts.ciphertext IS 'pd:personal — AES-256-GCM encrypted recovery contact value';
COMMENT ON COLUMN recovery_contacts.notice_version IS 'pd:none — privacy collection notice version acknowledged at save';
COMMENT ON COLUMN recovery_contacts.confirmed_at IS 'pd:none — initial contact confirmation timestamp';
COMMENT ON COLUMN recovery_contacts.updated_at IS 'pd:none — latest contact update timestamp';

-- console-gate: audited-table recovery_codes
CREATE TABLE recovery_codes (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL,
    batch_id        UUID        NOT NULL,
    code_index      SMALLINT    NOT NULL CHECK (code_index BETWEEN 1 AND 10),
    code_hash       BYTEA       NOT NULL CHECK (octet_length(code_hash) = 32),
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at     TIMESTAMPTZ NULL,
    revoked_at      TIMESTAMPTZ NULL,
    revoked_reason  TEXT        NULL CHECK (revoked_reason IS NULL OR char_length(btrim(revoked_reason)) BETWEEN 1 AND 64),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE,
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
    CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX recovery_codes_org_user_idx
    ON recovery_codes (org_id, user_id, generated_at DESC);
CREATE INDEX recovery_codes_hash_lookup_idx
    ON recovery_codes (code_hash);

ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON recovery_codes
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL ON recovery_codes FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON recovery_codes TO console_rt;
GRANT UPDATE (consumed_at, revoked_at, revoked_reason) ON recovery_codes TO console_rt;

COMMENT ON TABLE recovery_codes IS 'Keyed HMAC-SHA256 hashes of 10 single-use recovery codes for tenant ops account holders; cleartext codes are never stored.';
COMMENT ON COLUMN recovery_codes.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN recovery_codes.id IS 'pd:none — recovery code row identifier';
COMMENT ON COLUMN recovery_codes.user_id IS 'pd:personal — ops account holder user id';
COMMENT ON COLUMN recovery_codes.batch_id IS 'pd:none — 10-code issuance batch identifier';
COMMENT ON COLUMN recovery_codes.code_index IS 'pd:none — ordinal slot within batch (1..10)';
COMMENT ON COLUMN recovery_codes.code_hash IS 'pd:none — keyed HMAC-SHA256 digest of single-use recovery code';
COMMENT ON COLUMN recovery_codes.generated_at IS 'pd:none — batch generation timestamp';
COMMENT ON COLUMN recovery_codes.consumed_at IS 'pd:none — single-use redemption timestamp';
COMMENT ON COLUMN recovery_codes.revoked_at IS 'pd:none — revocation timestamp on regeneration or holder release';
COMMENT ON COLUMN recovery_codes.revoked_reason IS 'pd:none — revocation reason token';

-- console-gate: audited-table recovery_contact_challenges
CREATE TABLE recovery_contact_challenges (
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id         UUID        NOT NULL,
    challenge_hash  BYTEA       NOT NULL CHECK (octet_length(challenge_hash) = 32),
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (user_id, org_id) REFERENCES users(id, org_id) ON DELETE CASCADE
);

CREATE INDEX recovery_contact_challenges_user_idx
    ON recovery_contact_challenges (org_id, user_id, issued_at DESC);

ALTER TABLE recovery_contact_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_contact_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON recovery_contact_challenges
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL ON recovery_contact_challenges FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON recovery_contact_challenges TO console_rt;
GRANT UPDATE (consumed_at) ON recovery_contact_challenges TO console_rt;

COMMENT ON TABLE recovery_contact_challenges IS 'Short-lived HMAC-hashed verification codes sent to an ops holder recovery contact during recovery sign-in.';
COMMENT ON COLUMN recovery_contact_challenges.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN recovery_contact_challenges.id IS 'pd:none — challenge identifier';
COMMENT ON COLUMN recovery_contact_challenges.user_id IS 'pd:personal — ops account holder user id';
COMMENT ON COLUMN recovery_contact_challenges.challenge_hash IS 'pd:none — keyed HMAC-SHA256 digest of out-of-band contact code';
COMMENT ON COLUMN recovery_contact_challenges.issued_at IS 'pd:none — challenge issuance timestamp';
COMMENT ON COLUMN recovery_contact_challenges.expires_at IS 'pd:none — challenge expiry timestamp';
COMMENT ON COLUMN recovery_contact_challenges.consumed_at IS 'pd:none — single-use consumption timestamp';
