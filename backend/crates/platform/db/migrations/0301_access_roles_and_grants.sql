-- BE-ROLES (decision #26 pilot roles slice; access-model §2.2, §2.6, §4.3,
-- §5.5, §11.3 subset). No seeds: every role is tenant-created.
--
-- access_roles           the role head (status, current version)
-- access_role_versions   append-only history of every version (≥ 3 years)
-- access_role_lines      the permission lines of one version: domain × levels
-- access_grants          account × role × scope node × [valid_from, valid_to)
-- access_grant_receipts  single-use preview receipts for a grant batch
--
-- A grant is enforced when ACTIVE, inside its dates, its role is ACTIVE, and
-- the tenant is OPERATING — or, in SETUP, when it is `effective_in_setup`
-- (「설정 단계부터 적용」). Go-live flips nothing here: the loader reads the
-- phase. Overlap of the same role over the same scope for one account is
-- refused by a trigger under a per-account lock (btree_gist is not installed).
--
-- Lane number (head+1 of integ/mr-b9); INTEG renumbers at merge.
SET LOCAL lock_timeout = '2s';

CREATE TABLE access_roles (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id          UUID        NOT NULL DEFAULT gen_random_uuid(),
    name_ko     TEXT        NOT NULL CHECK (char_length(btrim(name_ko)) BETWEEN 1 AND 60),
    name_en     TEXT        NULL CHECK (name_en IS NULL OR char_length(btrim(name_en)) BETWEEN 1 AND 60),
    description TEXT        NULL CHECK (description IS NULL OR char_length(description) <= 500),
    status      TEXT        NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
    version     INT         NOT NULL CHECK (version >= 1),
    created_by  UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX access_roles_name_uniq ON access_roles (org_id, lower(btrim(name_ko)))
    WHERE status <> 'RETIRED';

CREATE TABLE access_role_versions (
    org_id      UUID        NOT NULL,
    role_id     UUID        NOT NULL,
    version     INT         NOT NULL CHECK (version >= 1),
    name_ko     TEXT        NOT NULL,
    name_en     TEXT        NULL,
    description TEXT        NULL,
    status      TEXT        NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
    change_mode TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'OPERATING')),
    reason_code TEXT        NULL CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 100),
    reason_note TEXT        NULL CHECK (reason_note IS NULL OR char_length(reason_note) <= 500),
    created_by  UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, role_id, version),
    FOREIGN KEY (org_id, role_id) REFERENCES access_roles (org_id, id) ON DELETE CASCADE,
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

CREATE TABLE access_role_lines (
    org_id  UUID   NOT NULL,
    role_id UUID   NOT NULL,
    version INT    NOT NULL,
    domain  TEXT   NOT NULL CHECK (domain IN (
                'org', 'hr_basic', 'appointment', 'exit', 'attendance', 'pay', 'bank', 'evaluation',
                'sensitive', 'documents', 'notice', 'access', 'audit', 'settings', 'exceptions',
                'retention', 'tenant')),
    levels  TEXT[] NOT NULL CHECK (cardinality(levels) >= 1
                AND levels <@ ARRAY['view', 'edit', 'approve', 'export']::text[]),
    PRIMARY KEY (org_id, role_id, version, domain),
    FOREIGN KEY (org_id, role_id, version) REFERENCES access_role_versions (org_id, role_id, version) ON DELETE CASCADE
);

-- Versions and lines are history: never rewritten (a draft is deleted whole).
CREATE FUNCTION access_role_history_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'access role history is append-only (%)', TG_TABLE_NAME;
END $$;
CREATE TRIGGER trg_access_role_versions_immutable BEFORE UPDATE ON access_role_versions
    FOR EACH ROW EXECUTE FUNCTION access_role_history_immutable();
CREATE TRIGGER trg_access_role_lines_immutable BEFORE UPDATE ON access_role_lines
    FOR EACH ROW EXECUTE FUNCTION access_role_history_immutable();

CREATE TABLE access_grants (
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
    account_id          UUID        NOT NULL,
    role_id             UUID        NOT NULL,
    scope_kind          TEXT        NOT NULL CHECK (scope_kind IN ('TENANT', 'LEGAL_ENTITY', 'WORKPLACE', 'DEPARTMENT')),
    legal_entity_id     UUID        NULL,
    workplace_id        UUID        NULL,
    org_unit_id         UUID        NULL,
    include_descendants BOOLEAN     NOT NULL DEFAULT true,
    valid_from          TIMESTAMPTZ NOT NULL,
    valid_to            TIMESTAMPTZ NULL,
    effective_in_setup  BOOLEAN     NOT NULL DEFAULT false,
    status              TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
    change_mode         TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'OPERATING')),
    reason_code         TEXT        NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 100),
    reason_note         TEXT        NULL CHECK (reason_note IS NULL OR char_length(reason_note) <= 500),
    granted_by          UUID        NOT NULL,
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_by          UUID        NULL,
    revoked_at          TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (account_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (granted_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (revoked_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, role_id) REFERENCES access_roles (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, org_unit_id) REFERENCES org_units (org_id, id) ON DELETE RESTRICT,
    -- GR-5: nobody grants to themself.
    CONSTRAINT access_grants_no_self_grant CHECK (granted_by <> account_id),
    CONSTRAINT access_grants_period CHECK (valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT access_grants_scope_shape CHECK (
        (scope_kind = 'TENANT' AND legal_entity_id IS NULL AND workplace_id IS NULL AND org_unit_id IS NULL)
        OR (scope_kind = 'LEGAL_ENTITY' AND legal_entity_id IS NOT NULL AND workplace_id IS NULL AND org_unit_id IS NULL)
        OR (scope_kind = 'WORKPLACE' AND workplace_id IS NOT NULL AND legal_entity_id IS NULL AND org_unit_id IS NULL)
        OR (scope_kind = 'DEPARTMENT' AND org_unit_id IS NOT NULL AND legal_entity_id IS NULL AND workplace_id IS NULL)),
    CONSTRAINT access_grants_revoke_shape CHECK (
        (status = 'REVOKED') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX access_grants_account_idx ON access_grants (org_id, account_id) WHERE status = 'ACTIVE';
CREATE INDEX access_grants_role_idx ON access_grants (org_id, role_id);

-- Identity, scope and grantor never change; only the end date and the revoke
-- columns move, and a revoked grant is final.
CREATE FUNCTION access_grants_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (
        (NEW.org_id, NEW.id, NEW.account_id, NEW.role_id, NEW.scope_kind, NEW.legal_entity_id,
         NEW.workplace_id, NEW.org_unit_id, NEW.include_descendants, NEW.valid_from,
         NEW.effective_in_setup, NEW.change_mode, NEW.reason_code, NEW.reason_note,
         NEW.granted_by, NEW.granted_at)
        IS DISTINCT FROM
        (OLD.org_id, OLD.id, OLD.account_id, OLD.role_id, OLD.scope_kind, OLD.legal_entity_id,
         OLD.workplace_id, OLD.org_unit_id, OLD.include_descendants, OLD.valid_from,
         OLD.effective_in_setup, OLD.change_mode, OLD.reason_code, OLD.reason_note,
         OLD.granted_by, OLD.granted_at)
        OR OLD.status = 'REVOKED') THEN
        RAISE EXCEPTION 'access grant % is immutable except its end date and revoke', OLD.id;
    END IF;
    IF NEW.status = 'ACTIVE' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('access_grants:' || NEW.account_id::text, 0));
        IF EXISTS (
            SELECT 1 FROM access_grants g
            WHERE g.org_id = NEW.org_id AND g.account_id = NEW.account_id AND g.role_id = NEW.role_id
              AND g.id <> NEW.id AND g.status = 'ACTIVE' AND g.scope_kind = NEW.scope_kind
              AND g.include_descendants = NEW.include_descendants
              AND g.legal_entity_id IS NOT DISTINCT FROM NEW.legal_entity_id
              AND g.workplace_id IS NOT DISTINCT FROM NEW.workplace_id
              AND g.org_unit_id IS NOT DISTINCT FROM NEW.org_unit_id
              AND tstzrange(g.valid_from, g.valid_to) && tstzrange(NEW.valid_from, NEW.valid_to)
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '23P01', CONSTRAINT = 'access_grants_no_overlap',
                MESSAGE = 'the account already holds this role over this scope for an overlapping period';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_access_grants_guard BEFORE INSERT OR UPDATE ON access_grants
    FOR EACH ROW EXECUTE FUNCTION access_grants_guard();

CREATE TABLE access_grant_receipts (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    actor_id   UUID        NOT NULL,
    digest     TEXT        NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
    request    JSONB       NOT NULL CHECK (jsonb_typeof(request) = 'object'),
    refused    INT         NOT NULL CHECK (refused >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id)
);

ALTER TABLE access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_roles FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON access_roles FROM PUBLIC, console_rt;
ALTER TABLE access_role_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_role_versions FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON access_role_versions FROM PUBLIC, console_rt;
ALTER TABLE access_role_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_role_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON access_role_lines FROM PUBLIC, console_rt;
ALTER TABLE access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grants FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON access_grants FROM PUBLIC, console_rt;
ALTER TABLE access_grant_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grant_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON access_grant_receipts FROM PUBLIC, console_rt;
CREATE POLICY org_isolation ON access_roles
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY org_isolation ON access_role_versions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY org_isolation ON access_role_lines
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY org_isolation ON access_grants
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE POLICY org_isolation ON access_grant_receipts
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_access_roles_org_immutable BEFORE UPDATE ON access_roles
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_access_grants_org_immutable BEFORE UPDATE ON access_grants
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

GRANT SELECT, INSERT, DELETE ON access_roles TO console_rt;
GRANT UPDATE (name_ko, name_en, description, status, version, updated_at) ON access_roles TO console_rt;
GRANT SELECT, INSERT ON access_role_versions, access_role_lines TO console_rt;
GRANT SELECT, INSERT ON access_grants TO console_rt;
GRANT UPDATE (valid_to, status, revoked_by, revoked_at) ON access_grants TO console_rt;
GRANT SELECT, INSERT ON access_grant_receipts TO console_rt;
GRANT UPDATE (used_at) ON access_grant_receipts TO console_rt;

COMMENT ON TABLE access_roles IS 'Tenant-defined roles (access-model §2.2); no seeds, no presets (decision #19, #26)';
COMMENT ON COLUMN access_roles.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_roles.id IS 'pd:none — role id';
COMMENT ON COLUMN access_roles.name_ko IS 'pd:none — role name (tenant-chosen label)';
COMMENT ON COLUMN access_roles.name_en IS 'pd:none — optional English role name';
COMMENT ON COLUMN access_roles.description IS 'pd:none — role description';
COMMENT ON COLUMN access_roles.status IS 'pd:none — DRAFT | ACTIVE | RETIRED';
COMMENT ON COLUMN access_roles.version IS 'pd:none — current version number';
COMMENT ON COLUMN access_roles.created_by IS 'pd:personal — account that created the role';
COMMENT ON COLUMN access_roles.created_at IS 'pd:none — creation time';
COMMENT ON COLUMN access_roles.updated_at IS 'pd:none — last version time';
COMMENT ON TABLE access_role_versions IS 'Append-only versions of a tenant role (kept ≥ 3 years, GR-17)';
COMMENT ON COLUMN access_role_versions.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_role_versions.role_id IS 'pd:none — role id';
COMMENT ON COLUMN access_role_versions.version IS 'pd:none — version number';
COMMENT ON COLUMN access_role_versions.name_ko IS 'pd:none — role name at this version';
COMMENT ON COLUMN access_role_versions.name_en IS 'pd:none — English role name at this version';
COMMENT ON COLUMN access_role_versions.description IS 'pd:none — description at this version';
COMMENT ON COLUMN access_role_versions.status IS 'pd:none — status at this version';
COMMENT ON COLUMN access_role_versions.change_mode IS 'pd:none — SETUP or OPERATING when written';
COMMENT ON COLUMN access_role_versions.reason_code IS 'pd:none — role_change reason code, when required';
COMMENT ON COLUMN access_role_versions.reason_note IS 'pd:none — free-text note for the reason';
COMMENT ON COLUMN access_role_versions.created_by IS 'pd:personal — account that wrote this version';
COMMENT ON COLUMN access_role_versions.created_at IS 'pd:none — version time';
COMMENT ON TABLE access_role_lines IS 'Permission lines of one role version: data domain × levels (access-model §2.6)';
COMMENT ON COLUMN access_role_lines.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_role_lines.role_id IS 'pd:none — role id';
COMMENT ON COLUMN access_role_lines.version IS 'pd:none — role version';
COMMENT ON COLUMN access_role_lines.domain IS 'pd:none — platform data domain key';
COMMENT ON COLUMN access_role_lines.levels IS 'pd:none — view / edit / approve / export';
COMMENT ON TABLE access_grants IS 'Explicit grants: account × role × scope node × dates (access-model §2.3c, §4.3)';
COMMENT ON COLUMN access_grants.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_grants.id IS 'pd:none — grant id';
COMMENT ON COLUMN access_grants.account_id IS 'pd:personal — account that holds the grant';
COMMENT ON COLUMN access_grants.role_id IS 'pd:none — granted role';
COMMENT ON COLUMN access_grants.scope_kind IS 'pd:none — TENANT | LEGAL_ENTITY | WORKPLACE | DEPARTMENT';
COMMENT ON COLUMN access_grants.legal_entity_id IS 'pd:none — scope 법인';
COMMENT ON COLUMN access_grants.workplace_id IS 'pd:none — scope 사업장';
COMMENT ON COLUMN access_grants.org_unit_id IS 'pd:none — scope 부서';
COMMENT ON COLUMN access_grants.include_descendants IS 'pd:none — 하위 조직 포함';
COMMENT ON COLUMN access_grants.valid_from IS 'pd:none — start (inclusive)';
COMMENT ON COLUMN access_grants.valid_to IS 'pd:none — end (exclusive); NULL = open-ended';
COMMENT ON COLUMN access_grants.effective_in_setup IS 'pd:none — 설정 단계부터 적용';
COMMENT ON COLUMN access_grants.status IS 'pd:none — ACTIVE | REVOKED';
COMMENT ON COLUMN access_grants.change_mode IS 'pd:none — SETUP or OPERATING when granted';
COMMENT ON COLUMN access_grants.reason_code IS 'pd:none — role_change reason code';
COMMENT ON COLUMN access_grants.reason_note IS 'pd:none — free-text note for the reason';
COMMENT ON COLUMN access_grants.granted_by IS 'pd:personal — grantor account';
COMMENT ON COLUMN access_grants.granted_at IS 'pd:none — grant time';
COMMENT ON COLUMN access_grants.revoked_by IS 'pd:personal — account that revoked it';
COMMENT ON COLUMN access_grants.revoked_at IS 'pd:none — revoke time';
COMMENT ON TABLE access_grant_receipts IS 'Single-use grant batch preview receipts (access-model §6.2)';
COMMENT ON COLUMN access_grant_receipts.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_grant_receipts.id IS 'pd:none — receipt id';
COMMENT ON COLUMN access_grant_receipts.actor_id IS 'pd:personal — account that previewed';
COMMENT ON COLUMN access_grant_receipts.digest IS 'pd:none — sha256 of the normalized batch and its outcomes';
COMMENT ON COLUMN access_grant_receipts.request IS 'pd:none — the normalized batch (ids, scopes, dates, reason code)';
COMMENT ON COLUMN access_grant_receipts.refused IS 'pd:none — refused items at preview';
COMMENT ON COLUMN access_grant_receipts.expires_at IS 'pd:none — receipt expiry';
COMMENT ON COLUMN access_grant_receipts.used_at IS 'pd:none — time the receipt was applied';
COMMENT ON COLUMN access_grant_receipts.created_at IS 'pd:none — preview time';
