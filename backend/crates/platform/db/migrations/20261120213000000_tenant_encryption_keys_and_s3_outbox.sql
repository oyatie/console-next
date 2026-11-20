-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

-- console-gate: audited-table tenant_encryption_keys
CREATE TABLE tenant_encryption_keys (
    -- Intentionally no REFERENCES organizations(id): SHREDDED tombstones must
    -- survive tenant deletion in platform_force_remove_organization so any
    -- ciphertext restored from historical backups fails closed.
    org_id              UUID        NOT NULL,
    key_scope           TEXT        NOT NULL CHECK (key_scope IN ('rrn', 'mail')),
    key_version         INTEGER     NOT NULL CHECK (key_version >= 1),
    state               TEXT        NOT NULL CHECK (state IN ('ACTIVE', 'RETIRED', 'SHREDDED')),
    alg_id              TEXT        NOT NULL CHECK (char_length(btrim(alg_id)) BETWEEN 1 AND 64),
    kek_id              TEXT        NOT NULL CHECK (char_length(btrim(kek_id)) BETWEEN 1 AND 128),
    wrapped_dek         BYTEA       NULL CHECK (wrapped_dek IS NULL OR octet_length(wrapped_dek) BETWEEN 40 AND 256),
    key_fingerprint     BYTEA       NOT NULL CHECK (octet_length(key_fingerprint) = 32),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at          TIMESTAMPTZ NULL,
    shredded_at         TIMESTAMPTZ NULL,
    shredded_request_id UUID        NULL REFERENCES tenant_erase_requests(id),
    PRIMARY KEY (org_id, key_scope, key_version),
    CHECK ((state = 'SHREDDED') = (wrapped_dek IS NULL)),
    CHECK ((state = 'SHREDDED') = (shredded_at IS NOT NULL)),
    CHECK ((state = 'SHREDDED') = (shredded_request_id IS NOT NULL)),
    CHECK (state = 'ACTIVE' OR retired_at IS NOT NULL OR shredded_at IS NOT NULL)
);

ALTER TABLE tenant_encryption_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_encryption_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_encryption_keys
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL ON tenant_encryption_keys FROM PUBLIC, console_rt, console_platform_force_cmd;
GRANT SELECT, INSERT ON tenant_encryption_keys TO console_rt;
GRANT UPDATE (alg_id, kek_id, wrapped_dek, state, retired_at)
    ON tenant_encryption_keys TO console_rt;

COMMENT ON TABLE tenant_encryption_keys IS 'Per-tenant DEK hierarchy wrapped by master KmsProvider KEKs; supports cryptographic erasure.';
COMMENT ON COLUMN tenant_encryption_keys.org_id IS 'pd:none — tenant identifier (retained post-erasure for fail-closed SHREDDED tombstones)';
COMMENT ON COLUMN tenant_encryption_keys.key_scope IS 'pd:none — encryption domain scope (rrn or mail)';
COMMENT ON COLUMN tenant_encryption_keys.key_version IS 'pd:none — monotonic per-tenant DEK version (>= 1)';
COMMENT ON COLUMN tenant_encryption_keys.state IS 'pd:none — key lifecycle state (ACTIVE, RETIRED, SHREDDED)';
COMMENT ON COLUMN tenant_encryption_keys.alg_id IS 'pd:none — tenant DEK wrap suite identifier';
COMMENT ON COLUMN tenant_encryption_keys.kek_id IS 'pd:none — wrapping master KEK identifier in KmsProvider';
COMMENT ON COLUMN tenant_encryption_keys.wrapped_dek IS 'pd:none — 256-bit tenant DEK wrapped via KmsProvider (NULL when SHREDDED)';
COMMENT ON COLUMN tenant_encryption_keys.key_fingerprint IS 'pd:none — non-secret 32-byte SHA-256 fingerprint of wrapped key metadata';
COMMENT ON COLUMN tenant_encryption_keys.created_at IS 'pd:none — key provisioning timestamp';
COMMENT ON COLUMN tenant_encryption_keys.retired_at IS 'pd:none — key rotation retirement timestamp';
COMMENT ON COLUMN tenant_encryption_keys.shredded_at IS 'pd:none — cryptographic erasure timestamp';
COMMENT ON COLUMN tenant_encryption_keys.shredded_request_id IS 'pd:none — authorizing two-operator tenant_erase_requests id';

CREATE TABLE tenant_erase_s3_outbox (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Platform-owned sentinel org so outbox rows survive target tenant deletion.
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    target_org_id   UUID        NOT NULL,
    request_id      UUID        NOT NULL REFERENCES tenant_erase_requests(id),
    bucket_kind     TEXT        NOT NULL CHECK (bucket_kind IN ('PRIMARY', 'REPLICA', 'EXPLICIT')),
    explicit_bucket TEXT        NULL CHECK (explicit_bucket IS NULL OR char_length(btrim(explicit_bucket)) BETWEEN 1 AND 255),
    object_key      TEXT        NOT NULL CHECK (char_length(btrim(object_key)) > 0),
    attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT        NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((bucket_kind = 'EXPLICIT') = (explicit_bucket IS NOT NULL))
);

CREATE INDEX tenant_erase_s3_outbox_due_idx
    ON tenant_erase_s3_outbox (org_id, next_retry_at, created_at);

ALTER TABLE tenant_erase_s3_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_erase_s3_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_erase_s3_outbox
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL ON tenant_erase_s3_outbox FROM PUBLIC, console_rt, console_platform_force_cmd;
GRANT SELECT, UPDATE, DELETE ON tenant_erase_s3_outbox TO console_rt;

COMMENT ON TABLE tenant_erase_s3_outbox IS 'Platform-owned transactional outbox of S3 object keys queued for post-commit purge on two-operator tenant erasure.';
COMMENT ON COLUMN tenant_erase_s3_outbox.id IS 'pd:none — outbox entry identifier';
COMMENT ON COLUMN tenant_erase_s3_outbox.org_id IS 'pd:none — platform sentinel org scope';
COMMENT ON COLUMN tenant_erase_s3_outbox.target_org_id IS 'pd:none — erased tenant identifier';
COMMENT ON COLUMN tenant_erase_s3_outbox.request_id IS 'pd:none — authorizing tenant_erase_requests id';
COMMENT ON COLUMN tenant_erase_s3_outbox.bucket_kind IS 'pd:none — target bucket selector (PRIMARY, REPLICA, EXPLICIT)';
COMMENT ON COLUMN tenant_erase_s3_outbox.explicit_bucket IS 'pd:none — explicit bucket name when bucket_kind is EXPLICIT';
COMMENT ON COLUMN tenant_erase_s3_outbox.object_key IS 'pd:personal — S3 object key queued for post-commit deletion (row deleted on purge)';
COMMENT ON COLUMN tenant_erase_s3_outbox.attempts IS 'pd:none — number of purge attempts';
COMMENT ON COLUMN tenant_erase_s3_outbox.next_retry_at IS 'pd:none — earliest retry timestamp';
COMMENT ON COLUMN tenant_erase_s3_outbox.last_error IS 'pd:none — non-secret transport/WORM deferral code';
COMMENT ON COLUMN tenant_erase_s3_outbox.created_at IS 'pd:none — outbox enqueue timestamp';

ALTER TABLE tenant_erase_requests
    ADD COLUMN erasure_witness_seq BIGINT;
ALTER TABLE tenant_erase_requests
    ADD COLUMN erasure_witness_hash BYTEA CHECK (erasure_witness_hash IS NULL OR (octet_length(erasure_witness_hash) = 32));
ALTER TABLE tenant_erase_requests
    ADD COLUMN shredded_key_fingerprint BYTEA CHECK (shredded_key_fingerprint IS NULL OR (octet_length(shredded_key_fingerprint) = 32));

COMMENT ON COLUMN tenant_erase_requests.erasure_witness_seq IS 'pd:none — erasure_ledger sequence recorded during tenant DEK shred';
COMMENT ON COLUMN tenant_erase_requests.erasure_witness_hash IS 'pd:none — erasure_ledger entry_hash recorded during tenant DEK shred';
COMMENT ON COLUMN tenant_erase_requests.shredded_key_fingerprint IS 'pd:none — SHA-256 fingerprint of shredded tenant DEK metadata';
