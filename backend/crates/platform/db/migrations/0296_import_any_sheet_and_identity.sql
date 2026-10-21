-- IMPORT-2 (decisions #25, #26; backend-followups item 22): migration-in from
-- any spreadsheet, identity by 사번 then 주민등록번호, 사번 변경 and renumbering.
-- Numbered head+1 of the parked employee stack (integ/mr-b9, 0295); INTEG
-- renumbers it at the batch merge (tools/integ/renumber-migrations.sh also
-- rewrites the include_str! pins in crates/settings/domain).
--
-- 1. employee_rrn: one sealed 주민등록번호 per employee (decisions #25,
--    개인정보 보호법 §24조의2②, 안전성 확보조치 기준). The value is sealed by
--    the application (envelope AEAD, key from the environment, never in the
--    database) and matched only through a keyed hash (HMAC-SHA256, key from
--    the environment). `masked` is the RRN's own first seven digits
--    (생년월일 + 성별 digit) and the rest as '*'. Never in raw rows, logs or
--    exports: no view, export or audit snapshot selects this table. Kept in a
--    table of its own so no `SELECT e.*`/`to_jsonb(e)` of `employees` can
--    carry it. Not unique on the hash: a 재입사 may be a second record of one
--    person. Its rows go when the record's personal data is destroyed (MR-26
--    tombstone, the trigger below). No UPDATE grant: a re-record (person
--    form) is a DELETE + INSERT in one transaction.
-- 2. data_import_row_identities: the sealed RRN of an import row between the
--    preview and the apply (never in data_import_rows.raw_row). The apply
--    moves it to employee_rrn and deletes the staged row; a run never applied
--    is purged after `import.staged_identity.ttl_days` (next preview).
-- 3. Mapping memory (per tenant): a header label the operator mapped to a
--    target (or to nothing) and a cell value mapped to a code or a record id.
--    Labels and unit/사업장/code texts only, never a cell of a person.
-- 4. employee_number_rules: the tenant numbering rule (prefix + width) per
--    tenant, 법인 or 사업장. A prefix is text, which the settings registry
--    cannot hold (Int/Bool/Code only), so the rule is tenant data; whether
--    unnumbered rows are assigned at all is the registry key
--    `import.employee_number.unnumbered`. The next number is computed from
--    the numbers in use (current and alias), never a stored counter.
-- 5. employee_number_changes: 사번 변경 (not 정정) with an effective date and
--    a reason code. `from_number` stays the person's alias (it still finds
--    them and is never handed to anyone else); every reference is the UUID.
--    A renumber batch is one employee_renumber_batches row and its changes;
--    an undo (SETUP only) restores the old numbers and marks both.
-- 6. setting_definition() and system_reason_codes() regenerated (the IMPORT-2
--    keys; the rrn_reveal and employee_number_change reason domains).
--
-- No seed rows.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. employee_rrn
CREATE TABLE employee_rrn (
    org_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    employee_id      UUID        NOT NULL,
    rrn_hmac         BYTEA       NOT NULL CHECK (octet_length(rrn_hmac) = 32),
    hmac_key_version SMALLINT    NOT NULL CHECK (hmac_key_version > 0),
    ciphertext       BYTEA       NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 256),
    nonce            BYTEA       NOT NULL CHECK (octet_length(nonce) = 24),
    dek_wrapped      BYTEA       NOT NULL CHECK (octet_length(dek_wrapped) BETWEEN 16 AND 256),
    dek_nonce        BYTEA       NOT NULL CHECK (octet_length(dek_nonce) = 24),
    key_version      SMALLINT    NOT NULL CHECK (key_version > 0),
    masked           TEXT        NOT NULL CHECK (masked ~ '^[0-9]{6}-[1-8]\*{6}$'),
    source           TEXT        NOT NULL CHECK (source IN ('IMPORT', 'FORM')),
    import_run_id    UUID        NULL,
    recorded_by      UUID        NOT NULL,
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, employee_id),
    CHECK ((source = 'IMPORT') = (import_run_id IS NOT NULL)),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (recorded_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX employee_rrn_hmac_idx ON employee_rrn (org_id, rrn_hmac);

-- The tombstone (0292 employee_void_destroy_pii) destroys a voided record's
-- personal data; its sealed RRN goes with it.
CREATE FUNCTION employee_rrn_destroy_with_pii() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM employee_rrn r WHERE r.org_id = NEW.org_id AND r.employee_id = NEW.id;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_employee_rrn_destroy_with_pii
    AFTER UPDATE OF pii_destroyed_at ON employees
    FOR EACH ROW WHEN (OLD.pii_destroyed_at IS NULL AND NEW.pii_destroyed_at IS NOT NULL)
    EXECUTE FUNCTION employee_rrn_destroy_with_pii();

-- ---------------------------------------------------------------------------
-- 2. data_import_row_identities
CREATE TABLE data_import_row_identities (
    org_id           UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    run_id           UUID        NOT NULL,
    source_key       TEXT        NOT NULL CHECK (btrim(source_key) <> ''),
    rrn_hmac         BYTEA       NOT NULL CHECK (octet_length(rrn_hmac) = 32),
    hmac_key_version SMALLINT    NOT NULL CHECK (hmac_key_version > 0),
    ciphertext       BYTEA       NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 256),
    nonce            BYTEA       NOT NULL CHECK (octet_length(nonce) = 24),
    dek_wrapped      BYTEA       NOT NULL CHECK (octet_length(dek_wrapped) BETWEEN 16 AND 256),
    dek_nonce        BYTEA       NOT NULL CHECK (octet_length(dek_nonce) = 24),
    key_version      SMALLINT    NOT NULL CHECK (key_version > 0),
    masked           TEXT        NOT NULL CHECK (masked ~ '^[0-9]{6}-[1-8]\*{6}$'),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, run_id, source_key),
    FOREIGN KEY (run_id, org_id) REFERENCES data_import_runs (id, org_id) ON DELETE CASCADE
);
CREATE INDEX data_import_row_identities_age_idx ON data_import_row_identities (org_id, created_at);

-- ---------------------------------------------------------------------------
-- 3. Mapping memory
CREATE TABLE import_column_memory (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    header_key TEXT        NOT NULL CHECK (char_length(header_key) BETWEEN 1 AND 100),
    -- NULL: the operator said this column is not imported.
    target     TEXT        NULL CHECK (target IS NULL OR target ~ '^[a-z_]{1,40}$'),
    updated_by UUID        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, header_key),
    FOREIGN KEY (updated_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

CREATE TABLE import_value_memory (
    org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    field        TEXT        NOT NULL CHECK (field IN (
        'org_unit', 'workplace', 'employment_type', 'employment_status', 'leave_type')),
    source_value TEXT        NOT NULL CHECK (char_length(source_value) BETWEEN 0 AND 200),
    -- A code or a record id as text; NULL: the operator chose "none" (미배치).
    mapped       TEXT        NULL CHECK (mapped IS NULL OR char_length(mapped) BETWEEN 1 AND 64),
    updated_by   UUID        NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, field, source_value),
    FOREIGN KEY (updated_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 4. employee_number_rules
CREATE TABLE employee_number_rules (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    scope_kind TEXT        NOT NULL CHECK (scope_kind IN ('TENANT', 'LEGAL_ENTITY', 'WORKPLACE')),
    -- TENANT: the org id itself; otherwise the 법인 / 사업장 id.
    scope_id   UUID        NOT NULL,
    prefix     TEXT        NOT NULL CHECK (prefix ~ '^[A-Za-z0-9_-]{0,16}$'),
    width      SMALLINT    NOT NULL CHECK (width BETWEEN 1 AND 12),
    updated_by UUID        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, scope_kind, scope_id),
    CHECK (scope_kind <> 'TENANT' OR scope_id = org_id),
    FOREIGN KEY (updated_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 5. 사번 변경 and renumber batches
CREATE TABLE employee_renumber_batches (
    org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id             UUID        NOT NULL DEFAULT gen_random_uuid(),
    scope_kind     TEXT        NOT NULL CHECK (scope_kind IN ('TENANT', 'LEGAL_ENTITY', 'WORKPLACE')),
    scope_id       UUID        NOT NULL,
    prefix         TEXT        NOT NULL CHECK (prefix ~ '^[A-Za-z0-9_-]{0,16}$'),
    width          SMALLINT    NOT NULL CHECK (width BETWEEN 1 AND 12),
    effective_date DATE        NOT NULL,
    reason_code    TEXT        NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 64),
    preview_digest TEXT        NOT NULL CHECK (preview_digest ~ '^[0-9a-f]{64}$'),
    change_mode    TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'GOVERNED', 'SOLE_HOLDER')),
    changed        INTEGER     NOT NULL CHECK (changed >= 0),
    actor_id       UUID        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    undone_by      UUID        NULL,
    undone_at      TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    CHECK ((undone_by IS NULL) = (undone_at IS NULL)),
    FOREIGN KEY (actor_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (undone_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX employee_renumber_batches_recent_idx ON employee_renumber_batches (org_id, created_at DESC);

CREATE TABLE employee_number_changes (
    org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id             UUID        NOT NULL DEFAULT gen_random_uuid(),
    employee_id    UUID        NOT NULL,
    from_number    TEXT        NULL CHECK (from_number IS NULL OR btrim(from_number) <> ''),
    to_number      TEXT        NOT NULL CHECK (btrim(to_number) <> '' AND char_length(to_number) <= 40),
    effective_date DATE        NOT NULL,
    reason_code    TEXT        NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 64),
    note           TEXT        NULL CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
    batch_id       UUID        NULL,
    changed_by     UUID        NOT NULL,
    changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    undone_at      TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    CHECK (from_number IS DISTINCT FROM to_number),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, batch_id) REFERENCES employee_renumber_batches (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (changed_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE INDEX employee_number_changes_employee_idx ON employee_number_changes (org_id, employee_id, changed_at);
CREATE INDEX employee_number_changes_alias_idx ON employee_number_changes (org_id, from_number)
    WHERE undone_at IS NULL AND from_number IS NOT NULL;

-- Kept: only undone_at may be set, once (and a batch's undone pair, once).
CREATE FUNCTION employee_number_history_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% rows are kept', TG_TABLE_NAME;
    END IF;
    IF TG_TABLE_NAME = 'employee_number_changes' THEN
        IF (to_jsonb(NEW) - 'undone_at') IS DISTINCT FROM (to_jsonb(OLD) - 'undone_at')
           OR OLD.undone_at IS NOT NULL THEN
            RAISE EXCEPTION 'employee_number_changes rows are immutable except undone_at, once';
        END IF;
    ELSIF (to_jsonb(NEW) - 'undone_at' - 'undone_by') IS DISTINCT FROM (to_jsonb(OLD) - 'undone_at' - 'undone_by')
          OR OLD.undone_at IS NOT NULL THEN
        RAISE EXCEPTION 'employee_renumber_batches rows are immutable except the undo, once';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_employee_number_changes_guard BEFORE UPDATE OR DELETE ON employee_number_changes
    FOR EACH ROW EXECUTE FUNCTION employee_number_history_guard();
CREATE TRIGGER trg_employee_renumber_batches_guard BEFORE UPDATE OR DELETE ON employee_renumber_batches
    FOR EACH ROW EXECUTE FUNCTION employee_number_history_guard();

-- ---------------------------------------------------------------------------
-- RLS and grants
ALTER TABLE employee_rrn ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_rrn FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_rrn
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_rrn_org_immutable BEFORE UPDATE ON employee_rrn
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE data_import_row_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_import_row_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON data_import_row_identities
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE import_column_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_column_memory FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_column_memory
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_import_column_memory_org_immutable BEFORE UPDATE ON import_column_memory
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE import_value_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_value_memory FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_value_memory
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_import_value_memory_org_immutable BEFORE UPDATE ON import_value_memory
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE employee_number_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_number_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_number_rules
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_number_rules_org_immutable BEFORE UPDATE ON employee_number_rules
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE employee_renumber_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_renumber_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_renumber_batches
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_renumber_batches_org_immutable BEFORE UPDATE ON employee_renumber_batches
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

ALTER TABLE employee_number_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_number_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_number_changes
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employee_number_changes_org_immutable BEFORE UPDATE ON employee_number_changes
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

REVOKE ALL PRIVILEGES ON employee_rrn, data_import_row_identities, import_column_memory,
    import_value_memory, employee_number_rules, employee_renumber_batches, employee_number_changes
    FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, DELETE ON employee_rrn, data_import_row_identities TO console_rt;
GRANT SELECT, INSERT, UPDATE ON import_column_memory, import_value_memory, employee_number_rules
    TO console_rt;
GRANT DELETE ON employee_number_rules TO console_rt;
GRANT SELECT, INSERT ON employee_renumber_batches, employee_number_changes TO console_rt;
GRANT UPDATE (undone_at, undone_by) ON employee_renumber_batches TO console_rt;
GRANT UPDATE (undone_at) ON employee_number_changes TO console_rt;

-- ---------------------------------------------------------------------------
-- Classification
COMMENT ON TABLE employee_rrn IS 'IMPORT-2 (decisions #25): sealed 주민등록번호 per employee; matched by keyed hash, revealed only with a reason and a 접속기록 row';
COMMENT ON COLUMN employee_rrn.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_rrn.employee_id IS 'pd:personal — the employee; row is a natural person';
COMMENT ON COLUMN employee_rrn.rrn_hmac IS 'pd:unique-id/rrn — HMAC-SHA256 of the 주민등록번호 (key outside the database), the matching key';
COMMENT ON COLUMN employee_rrn.hmac_key_version IS 'pd:none — which HMAC key made rrn_hmac';
COMMENT ON COLUMN employee_rrn.ciphertext IS 'pd:unique-id/rrn — 주민등록번호 sealed (XChaCha20-Poly1305, per-row DEK)';
COMMENT ON COLUMN employee_rrn.nonce IS 'pd:none — AEAD nonce';
COMMENT ON COLUMN employee_rrn.dek_wrapped IS 'pd:none — the row key sealed under the master key';
COMMENT ON COLUMN employee_rrn.dek_nonce IS 'pd:none — AEAD nonce of the wrapped row key';
COMMENT ON COLUMN employee_rrn.key_version IS 'pd:none — master key version';
COMMENT ON COLUMN employee_rrn.masked IS 'pd:unique-id/rrn — 앞 7자리(생년월일·성별)만 남긴 마스킹 값';
COMMENT ON COLUMN employee_rrn.source IS 'pd:none — IMPORT or FORM';
COMMENT ON COLUMN employee_rrn.import_run_id IS 'pd:none — the import run that recorded it';
COMMENT ON COLUMN employee_rrn.recorded_by IS 'pd:personal — user who recorded it';
COMMENT ON COLUMN employee_rrn.recorded_at IS 'pd:none — when it was recorded';

COMMENT ON TABLE data_import_row_identities IS 'IMPORT-2: sealed 주민등록번호 of an import row between preview and apply (never in raw_row)';
COMMENT ON COLUMN data_import_row_identities.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN data_import_row_identities.run_id IS 'pd:none — import run';
COMMENT ON COLUMN data_import_row_identities.source_key IS 'pd:personal — 원본 파일·시트·행 위치 (행이 사람 한 명)';
COMMENT ON COLUMN data_import_row_identities.rrn_hmac IS 'pd:unique-id/rrn — HMAC-SHA256 of the 주민등록번호';
COMMENT ON COLUMN data_import_row_identities.hmac_key_version IS 'pd:none — which HMAC key made rrn_hmac';
COMMENT ON COLUMN data_import_row_identities.ciphertext IS 'pd:unique-id/rrn — 주민등록번호 sealed';
COMMENT ON COLUMN data_import_row_identities.nonce IS 'pd:none — AEAD nonce';
COMMENT ON COLUMN data_import_row_identities.dek_wrapped IS 'pd:none — the row key sealed under the master key';
COMMENT ON COLUMN data_import_row_identities.dek_nonce IS 'pd:none — AEAD nonce of the wrapped row key';
COMMENT ON COLUMN data_import_row_identities.key_version IS 'pd:none — master key version';
COMMENT ON COLUMN data_import_row_identities.masked IS 'pd:unique-id/rrn — 앞 7자리만 남긴 마스킹 값';
COMMENT ON COLUMN data_import_row_identities.created_at IS 'pd:none — staging time (purged after the TTL key)';

COMMENT ON TABLE import_column_memory IS 'IMPORT-2: header label → import target the tenant mapped (mapping memory)';
COMMENT ON COLUMN import_column_memory.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN import_column_memory.header_key IS 'pd:none — normalised header label (a column title, not a cell)';
COMMENT ON COLUMN import_column_memory.target IS 'pd:none — import target; NULL = not imported';
COMMENT ON COLUMN import_column_memory.updated_by IS 'pd:personal — user who mapped it';
COMMENT ON COLUMN import_column_memory.updated_at IS 'pd:none — last change';

COMMENT ON TABLE import_value_memory IS 'IMPORT-2: cell value → code or record id the tenant mapped (부서·사업장·고용형태·재직상태·휴직 유형 texts)';
COMMENT ON COLUMN import_value_memory.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN import_value_memory.field IS 'pd:none — which mapping';
COMMENT ON COLUMN import_value_memory.source_value IS 'pd:none — a unit, 사업장 or code text as the files write it';
COMMENT ON COLUMN import_value_memory.mapped IS 'pd:none — the code or record id; NULL = none (미배치)';
COMMENT ON COLUMN import_value_memory.updated_by IS 'pd:personal — user who mapped it';
COMMENT ON COLUMN import_value_memory.updated_at IS 'pd:none — last change';

COMMENT ON TABLE employee_number_rules IS 'IMPORT-2: 사번 numbering rule (prefix + width) per tenant, 법인 or 사업장';
COMMENT ON COLUMN employee_number_rules.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_number_rules.scope_kind IS 'pd:none — TENANT, LEGAL_ENTITY or WORKPLACE';
COMMENT ON COLUMN employee_number_rules.scope_id IS 'pd:none — the org, 법인 or 사업장 id';
COMMENT ON COLUMN employee_number_rules.prefix IS 'pd:none — 사번 prefix';
COMMENT ON COLUMN employee_number_rules.width IS 'pd:none — digits of the sequence part';
COMMENT ON COLUMN employee_number_rules.updated_by IS 'pd:personal — user who set the rule';
COMMENT ON COLUMN employee_number_rules.updated_at IS 'pd:none — last change';

COMMENT ON TABLE employee_renumber_batches IS 'IMPORT-2: one bulk 사번 renumbering (old → new) of a scope; undoable in SETUP';
COMMENT ON COLUMN employee_renumber_batches.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_renumber_batches.id IS 'pd:none — batch id';
COMMENT ON COLUMN employee_renumber_batches.scope_kind IS 'pd:none — TENANT, LEGAL_ENTITY or WORKPLACE';
COMMENT ON COLUMN employee_renumber_batches.scope_id IS 'pd:none — the org, 법인 or 사업장 id';
COMMENT ON COLUMN employee_renumber_batches.prefix IS 'pd:none — the new scheme prefix';
COMMENT ON COLUMN employee_renumber_batches.width IS 'pd:none — the new scheme width';
COMMENT ON COLUMN employee_renumber_batches.effective_date IS 'pd:none — when the new numbers take effect';
COMMENT ON COLUMN employee_renumber_batches.reason_code IS 'pd:none — employee_number_change reason code';
COMMENT ON COLUMN employee_renumber_batches.preview_digest IS 'pd:none — sha-256 of the preview the operator saw';
COMMENT ON COLUMN employee_renumber_batches.change_mode IS 'pd:none — tenant phase mode of the write';
COMMENT ON COLUMN employee_renumber_batches.changed IS 'pd:none — people renumbered';
COMMENT ON COLUMN employee_renumber_batches.actor_id IS 'pd:personal — user who applied it';
COMMENT ON COLUMN employee_renumber_batches.created_at IS 'pd:none — apply time';
COMMENT ON COLUMN employee_renumber_batches.undone_by IS 'pd:personal — user who undid it';
COMMENT ON COLUMN employee_renumber_batches.undone_at IS 'pd:none — undo time';

COMMENT ON TABLE employee_number_changes IS 'IMPORT-2: 사번 변경 history; from_number stays the person''s alias';
COMMENT ON COLUMN employee_number_changes.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_number_changes.id IS 'pd:none — change id';
COMMENT ON COLUMN employee_number_changes.employee_id IS 'pd:personal — the employee; row is a natural person';
COMMENT ON COLUMN employee_number_changes.from_number IS 'pd:personal — 이전 사번 (별칭으로 계속 검색됨); NULL = 사번 미부여였음';
COMMENT ON COLUMN employee_number_changes.to_number IS 'pd:personal — 새 사번';
COMMENT ON COLUMN employee_number_changes.effective_date IS 'pd:none — 변경 시행일';
COMMENT ON COLUMN employee_number_changes.reason_code IS 'pd:none — employee_number_change reason code';
COMMENT ON COLUMN employee_number_changes.note IS 'pd:personal — 사유 메모(자유 기재, 개인정보가 섞일 수 있음)';
COMMENT ON COLUMN employee_number_changes.batch_id IS 'pd:none — the renumber batch, if any';
COMMENT ON COLUMN employee_number_changes.changed_by IS 'pd:personal — user who changed it';
COMMENT ON COLUMN employee_number_changes.changed_at IS 'pd:none — when it was recorded';
COMMENT ON COLUMN employee_number_changes.undone_at IS 'pd:none — set when a SETUP undo restored the old number';

-- ---------------------------------------------------------------------------
-- 6. Settings and reason codes (generated; see the two BEGIN GENERATED pins)
DROP FUNCTION setting_definition(TEXT);

-- BEGIN GENERATED by console-settings-domain tests/sql_definitions.rs
CREATE FUNCTION setting_definition(
    p_key TEXT,
    OUT kind TEXT,
    OUT min_value BIGINT,
    OUT max_value BIGINT,
    OUT default_ordinal BIGINT,
    OUT looser_when TEXT,
    OUT governance TEXT,
    OUT codes TEXT[]
)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT d.kind, d.min_value, d.max_value, d.default_ordinal, d.looser_when, d.governance, d.codes
    FROM (VALUES
        ('approval.overdue.escalate_after_business_days', 'int', 1::BIGINT, NULL::BIGINT, 2::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.delegation.max_days', 'int', 1::BIGINT, 90::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.returned.reminder_days', 'int', 1::BIGINT, NULL::BIGINT, 3::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.doc_class.registered_branch_change.requires_governing_body_decision', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'lower', 'fixed', NULL::TEXT[]),
        ('approval.doc_class.registered_manager_appointment.requires_governing_body_decision', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'lower', 'fixed', NULL::TEXT[]),
        ('corporate.small_company_383_proviso', 'bool', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.date.backdate_soft_days', 'int', 3::BIGINT, 14::BIGINT, 14::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.date.future_soft_days', 'int', 30::BIGINT, 365::BIGINT, 90::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.date_unknown.resolve_days', 'int', 1::BIGINT, 14::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.hq_review.lead_days', 'int', 1::BIGINT, 30::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('exit.hq_review.post_apply_days', 'int', 1::BIGINT, 30::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.access.revoke_mode.voluntary', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['ON_CONFIRM', 'END_OF_EXIT_DATE']::TEXT[]),
        ('exit.access.revoke_mode.involuntary', 'code', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', ARRAY['ON_CONFIRM', 'END_OF_EXIT_DATE']::TEXT[]),
        ('exit.access.handover_max_days', 'int', 0::BIGINT, 30::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.access.self_service_days', 'int', 30::BIGINT, 1095::BIGINT, 90::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exit.settlement.wage_deviation_pct', 'int', 0::BIGINT, 10::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('lifecycle.backdate_soft_floor_days', 'int', 0::BIGINT, 90::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('exceptions.approval_ttl_days', 'int', 1::BIGINT, 30::BIGINT, 14::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('withholding.filing_cadence', 'code', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, 'neutral', 'tenant', ARRAY['MONTHLY', 'SEMIANNUAL']::TEXT[]),
        ('period_lock.unlock_max_days', 'int', 1::BIGINT, 14::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('auth.idle_timeout_minutes', 'int', 5::BIGINT, 60::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('authz.sole_holder.mode', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['refuse', 'step_up_notice_review']::TEXT[]),
        ('authz.elevated_grant.sole_admin_delay', 'int', 24::BIGINT, 168::BIGINT, 24::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('authz.second_person.min_grant_age', 'int', 1::BIGINT, 30::BIGINT, 7::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('authz.second_person.response_due', 'int', 1::BIGINT, 120::BIGINT, 48::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('security_contact.reverify_interval', 'int', 1::BIGINT, 12::BIGINT, 12::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('review.sole_holder_exception.due', 'int', 1::BIGINT, 90::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('audit.permission_change.retention', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('audit.access_log.retention', 'int', 2::BIGINT, NULL::BIGINT, 2::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('offboarding.cooling_period', 'int', 3::BIGINT, NULL::BIGINT, 7::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('offboarding.retrieval_window', 'int', 30::BIGINT, NULL::BIGINT, 60::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('offboarding.destroy_after_due', 'int', 0::BIGINT, 5::BIGINT, 5::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('offboarding.archive_service.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'neutral', 'platform_only', NULL::TEXT[]),
        ('backup.archive_tail', 'int', NULL::BIGINT, NULL::BIGINT, 35::BIGINT, 'neutral', 'read_only', NULL::TEXT[]),
        ('privacy.exit_processing_overdue_after', 'int', 1::BIGINT, 180::BIGINT, 90::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('retention.labor.employee_register', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.employment_contract', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.wage_ledger', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.wage_basis', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.hire_exit', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.promotion_pay_change', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.leave', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.written_agreements', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.labor.minor_proof', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.tax.books_evidence', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.nhis.employer_docs', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.nps.member_notice_proof', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.equality.docs', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.equality.grievance', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.severance.interim_proof', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.safety.docs', 'int', 3::BIGINT, NULL::BIGINT, 3::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.recruiting.docs', 'int', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('authz.cross_entity_grant.basis_required', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('retention.entity_registration_document', 'int', 5::BIGINT, NULL::BIGINT, 5::BIGINT, 'lower', 'tenant', NULL::TEXT[]),
        ('hr.record.education.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.qualification.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.military.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.training.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.language.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.award.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.discipline.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.family.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.disability.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('hr.record.veteran.enabled', 'bool', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('people.void_window', 'int', 1::BIGINT, 30::BIGINT, 14::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('people.void_pii_retention', 'int', 0::BIGINT, 30::BIGINT, 30::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
        ('approval.policy.org_structure', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('approval.policy.people_correction', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('approval.policy.identity_merge', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('approval.policy.registration_void', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('approval.policy.exit', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['route', 'none']::TEXT[]),
        ('import.upload.max_mib', 'int', 1::BIGINT, 64::BIGINT, 16::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.zip.max_entries', 'int', 16::BIGINT, 10000::BIGINT, 1000::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.zip.max_expanded_mib', 'int', 1::BIGINT, 1024::BIGINT, 128::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.zip.max_ratio', 'int', 10::BIGINT, 1000::BIGINT, 200::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.sheet.max_grid_cells', 'int', 1000::BIGINT, 50000000::BIGINT, 5000000::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.workbook.max_cells', 'int', 1000::BIGINT, 10000000::BIGINT, 2000000::BIGINT, 'higher', 'platform_only', NULL::TEXT[]),
        ('import.employee_number.unnumbered', 'code', NULL::BIGINT, NULL::BIGINT, 1::BIGINT, 'higher', 'tenant', ARRAY['queue', 'assign_by_rule']::TEXT[]),
        ('import.staged_identity.ttl_days', 'int', 1::BIGINT, 30::BIGINT, 7::BIGINT, 'higher', 'tenant', NULL::TEXT[])
    ) AS d (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)
    WHERE d.key = p_key
$$;
-- END GENERATED

DROP FUNCTION system_reason_codes();

-- BEGIN GENERATED by console-settings-domain code_lists/tests.rs
CREATE FUNCTION system_reason_codes()
RETURNS TABLE (domain TEXT, code TEXT, requires_note BOOLEAN, sort INT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    VALUES
        ('org_change_reason', 'NEW_BUSINESS_SITE', false, 1),
        ('org_change_reason', 'CONSOLIDATION', false, 2),
        ('org_change_reason', 'WORK_REALLOCATION', false, 3),
        ('org_change_reason', 'RENAMING', false, 4),
        ('org_change_reason', 'COMPLIANCE_FINDING', false, 5),
        ('org_change_reason', 'OTHER', true, 6),
        ('org_change_reject', 'EFFECTIVE_DATE_REVIEW', false, 1),
        ('org_change_reject', 'INSUFFICIENT_BASIS', false, 2),
        ('org_change_reject', 'WRONG_TARGET', false, 3),
        ('org_change_reject', 'POLICY_VIOLATION', false, 4),
        ('org_change_reject', 'OTHER', true, 5),
        ('approval_return', 'NEEDS_SUPPLEMENT', false, 1),
        ('approval_return', 'ADD_EVIDENCE', false, 2),
        ('approval_return', 'ADJUST_EFFECTIVE_DATE', false, 3),
        ('approval_return', 'CORRECT_TARGET', false, 4),
        ('approval_return', 'OTHER', true, 5),
        ('org_change_cancel', 'DUPLICATE_DRAFT', false, 1),
        ('org_change_cancel', 'PLAN_CHANGED', false, 2),
        ('org_change_cancel', 'DRAFTING_ERROR', false, 3),
        ('org_change_cancel', 'OTHER', true, 4),
        ('org_change_withdraw', 'DUPLICATE_DRAFT', false, 1),
        ('org_change_withdraw', 'PLAN_CHANGED', false, 2),
        ('org_change_withdraw', 'DRAFTING_ERROR', false, 3),
        ('org_change_withdraw', 'OTHER', true, 4),
        ('lifecycle_transfer', 'REGULAR_RESHUFFLE', false, 1),
        ('lifecycle_transfer', 'REORGANIZATION', false, 2),
        ('lifecycle_transfer', 'EMPLOYEE_REQUEST', false, 3),
        ('lifecycle_transfer', 'BUSINESS_NEED', false, 4),
        ('lifecycle_transfer', 'OTHER', true, 5),
        ('lifecycle_promote', 'REGULAR_PROMOTION', false, 1),
        ('lifecycle_promote', 'SPECIAL_PROMOTION', false, 2),
        ('lifecycle_promote', 'DISCIPLINARY_DEMOTION', false, 3),
        ('lifecycle_promote', 'OTHER', true, 4),
        ('lifecycle_cancel', 'INPUT_ERROR', false, 1),
        ('lifecycle_cancel', 'SCHEDULE_CHANGED', false, 2),
        ('lifecycle_cancel', 'PLAN_WITHDRAWN', false, 3),
        ('lifecycle_cancel', 'OTHER', true, 4),
        ('exit_reason', 'PERSONAL', false, 1),
        ('exit_reason', 'FAMILY', false, 2),
        ('exit_reason', 'ILLNESS', false, 3),
        ('exit_reason', 'STUDY', false, 4),
        ('exit_reason', 'WORKING_CONDITIONS', false, 5),
        ('exit_reason', 'WAGE_ARREARS', false, 6),
        ('exit_reason', 'RELOCATION', false, 7),
        ('exit_reason', 'CLOSURE', false, 8),
        ('exit_reason', 'INSOLVENCY', false, 9),
        ('exit_reason', 'ADVISED_RESIGNATION_BUSINESS', false, 10),
        ('exit_reason', 'REDUNDANCY_DISMISSAL', false, 11),
        ('exit_reason', 'DISCIPLINARY_DISMISSAL', false, 12),
        ('exit_reason', 'ADVISED_RESIGNATION_FAULT', false, 13),
        ('exit_reason', 'RETIREMENT_AGE', false, 14),
        ('exit_reason', 'CONTRACT_END', false, 15),
        ('exit_reason', 'PROJECT_END', false, 16),
        ('exit_reason', 'COVERAGE_EXCLUDED', false, 17),
        ('exit_reason', 'DUAL_EMPLOYMENT', false, 18),
        ('exit_reason', 'DEATH', false, 19),
        ('exit_reason', 'OTHER', true, 20),
        ('exit_reject', 'EMPLOYEE_WITHDREW', false, 1),
        ('exit_reject', 'NOT_FACTUAL', false, 2),
        ('exit_reject', 'OTHER', true, 3),
        ('exit_cancel', 'EMPLOYEE_WITHDREW', false, 1),
        ('exit_cancel', 'REPORT_ERROR', false, 2),
        ('exit_cancel', 'OTHER', true, 3),
        ('period_lock', 'MONTHLY_PAYROLL_CLOSE', false, 1),
        ('period_lock', 'BOOKS_CLOSE', false, 2),
        ('period_lock', 'TAX_FILING', false, 3),
        ('period_lock', 'AUDIT_RESPONSE', false, 4),
        ('period_lock', 'OTHER', true, 5),
        ('period_unlock', 'RETRO_CORRECTION', false, 1),
        ('period_unlock', 'PAYROLL_ERROR', false, 2),
        ('period_unlock', 'AUDIT_FINDING', false, 3),
        ('period_unlock', 'OTHER', true, 4),
        ('role_change', 'PROMOTION_OR_REASSIGNMENT', false, 1),
        ('role_change', 'EXIT_OR_LEAVE', false, 2),
        ('role_change', 'ACCESS_CLEANUP', false, 3),
        ('role_change', 'ERROR_CORRECTION', false, 4),
        ('role_change', 'OTHER', true, 5),
        ('deactivate', 'EXIT', false, 1),
        ('deactivate', 'LEAVE', false, 2),
        ('deactivate', 'SECURITY_INCIDENT', false, 3),
        ('deactivate', 'DUPLICATE_ACCOUNT', false, 4),
        ('deactivate', 'OTHER', true, 5),
        ('credential_reset', 'DEVICE_LOST', false, 1),
        ('credential_reset', 'DEVICE_REPLACED', false, 2),
        ('credential_reset', 'COMPROMISE_SUSPECTED', false, 3),
        ('credential_reset', 'OTHER', true, 4),
        ('import_exclude', 'DUPLICATE', false, 1),
        ('import_exclude', 'FORMAT_ERROR', false, 2),
        ('import_exclude', 'OUT_OF_SCOPE', false, 3),
        ('import_exclude', 'OTHER', true, 4),
        ('exception', 'OTHER', true, 1),
        ('retained_record_purpose', 'EMPLOYMENT_CERTIFICATE', false, 1),
        ('retained_record_purpose', 'SEPARATION_CONFIRMATION', false, 2),
        ('retained_record_purpose', 'PAYMENT_STATEMENT_FILING', false, 3),
        ('retained_record_purpose', 'WITHHOLDING_CORRECTION', false, 4),
        ('retained_record_purpose', 'EXIT_PROCESSING_COMPLETION', false, 5),
        ('retained_record_purpose', 'DISPUTE_OR_INSPECTION', false, 6),
        ('retained_record_purpose', 'DATA_SUBJECT_ACCESS', false, 7),
        ('retained_record_purpose', 'OTHER', true, 8),
        ('restricted_record_purpose', 'STATUTORY_REPORTING', false, 1),
        ('restricted_record_purpose', 'WORK_ACCOMMODATION', false, 2),
        ('restricted_record_purpose', 'DISCIPLINARY_PROCEDURE', false, 3),
        ('restricted_record_purpose', 'RECORD_CORRECTION', false, 4),
        ('restricted_record_purpose', 'DISPUTE_OR_INSPECTION', false, 5),
        ('restricted_record_purpose', 'DATA_SUBJECT_ACCESS', false, 6),
        ('restricted_record_purpose', 'OTHER', true, 7),
        ('rrn_reveal', 'PAYROLL_WITHHOLDING', false, 1),
        ('rrn_reveal', 'SOCIAL_INSURANCE_FILING', false, 2),
        ('rrn_reveal', 'IDENTITY_VERIFICATION', false, 3),
        ('rrn_reveal', 'DATA_SUBJECT_ACCESS', false, 4),
        ('rrn_reveal', 'OTHER', true, 5),
        ('employee_number_change', 'NUMBERING_SCHEME_CHANGE', false, 1),
        ('employee_number_change', 'ENTITY_TRANSFER', false, 2),
        ('employee_number_change', 'INPUT_ERROR', false, 3),
        ('employee_number_change', 'LEGACY_MIGRATION', false, 4),
        ('employee_number_change', 'OTHER', true, 5)
$$;
-- END GENERATED
