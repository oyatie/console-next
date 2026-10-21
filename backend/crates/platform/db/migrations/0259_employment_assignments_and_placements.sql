-- Employment ↔ 법인/사업장 by id, OrgUnit placement, and the one-time
-- migration of existing company/SITE text into records (design §3.8, §3.9,
-- §3.13; challenge E-14, E-15).
--
-- Lane number (head+1 of trunk dccb092); INTEG renumbers at merge.
-- Writer crate: console-entity-adapter-postgres.
--
-- employment_assignments is the id-typed employer/workplace history. The
-- employees.company / worksite_name text stays a display snapshot only. No
-- gaps or overlaps among live rows: a trigger, because btree_gist is not
-- installed (the writer also locks the employee row FOR UPDATE first, which
-- serialises concurrent writers). A remap never rewrites a row: the old row
-- is superseded (one-way) and a CORRECTION row takes its period.
--
-- The data migration below is idempotent and non-destructive: it only inserts
-- what is missing, for tenants that already have people, SITE units or a
-- company revision. A tenant with nothing gets nothing (it builds its 법인 in
-- the setup rail). Everything it writes is change_mode MIGRATION and
-- needs_confirmation, so the setup rail / Home lists it for a person.
SET LOCAL lock_timeout = '2s';

-- A text → date cast that answers NULL instead of failing the migration on
-- one malformed legacy value (employees.hire_date is TEXT, 0066).
CREATE FUNCTION entity_try_iso_date(raw TEXT) RETURNS DATE
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF raw IS NULL OR raw !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RETURN NULL;
    END IF;
    RETURN raw::date;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 1. employment_assignments
CREATE TABLE employment_assignments (
    org_id            UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                UUID        NOT NULL DEFAULT gen_random_uuid(),
    employee_id       UUID        NOT NULL,
    legal_entity_id   UUID        NULL,
    workplace_id      UUID        NULL,
    valid_from        DATE        NOT NULL,
    valid_to          DATE        NULL,
    cause             TEXT        NOT NULL CHECK (cause IN (
                          'HIRE', 'TRANSFER', 'GROUP_TRANSFER', 'CORRECTION', 'SETUP_BIND',
                          'MIGRATION', 'MIGRATION_UNMAPPED')),
    group_transfer_id UUID        NULL,
    superseded_at     TIMESTAMPTZ NULL,
    actor_id          UUID        NULL,
    command_id        UUID        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    -- INTEG-1: one accepted command writes one row per employee at most.
    UNIQUE (org_id, command_id, employee_id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT employment_assignments_period CHECK (valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT employment_assignments_entity CHECK (legal_entity_id IS NOT NULL OR cause = 'MIGRATION_UNMAPPED'),
    CONSTRAINT employment_assignments_workplace CHECK (workplace_id IS NOT NULL OR cause IN ('MIGRATION', 'MIGRATION_UNMAPPED')),
    CONSTRAINT employment_assignments_actor CHECK (actor_id IS NOT NULL OR cause IN ('MIGRATION', 'MIGRATION_UNMAPPED')),
    CONSTRAINT employment_assignments_group_transfer CHECK ((cause = 'GROUP_TRANSFER') = (group_transfer_id IS NOT NULL))
);
CREATE INDEX employment_assignments_employee_idx
    ON employment_assignments (org_id, employee_id, valid_from) WHERE superseded_at IS NULL;
CREATE INDEX employment_assignments_entity_idx
    ON employment_assignments (org_id, legal_entity_id) WHERE superseded_at IS NULL;
CREATE INDEX employment_assignments_workplace_idx
    ON employment_assignments (org_id, workplace_id) WHERE superseded_at IS NULL;

CREATE FUNCTION employment_assignments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF (NEW.org_id, NEW.id, NEW.employee_id, NEW.legal_entity_id, NEW.workplace_id, NEW.valid_from,
            NEW.cause, NEW.group_transfer_id, NEW.actor_id, NEW.command_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.org_id, OLD.id, OLD.employee_id, OLD.legal_entity_id, OLD.workplace_id, OLD.valid_from,
            OLD.cause, OLD.group_transfer_id, OLD.actor_id, OLD.command_id, OLD.created_at) THEN
            RAISE EXCEPTION 'employment_assignments rows are immutable except closing (id=%)', OLD.id;
        END IF;
        IF OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
            RAISE EXCEPTION 'employment_assignments valid_to is set once (id=%)', OLD.id;
        END IF;
        IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
            RAISE EXCEPTION 'employment_assignments superseded_at is set once (id=%)', OLD.id;
        END IF;
    END IF;
    IF NEW.superseded_at IS NULL AND EXISTS (
        SELECT 1 FROM employment_assignments a
        WHERE a.org_id = NEW.org_id AND a.employee_id = NEW.employee_id AND a.id <> NEW.id
          AND a.superseded_at IS NULL
          AND daterange(a.valid_from, a.valid_to) && daterange(NEW.valid_from, NEW.valid_to)
    ) THEN
        RAISE EXCEPTION 'employment assignment overlaps another for employee % (assignment_overlap)', NEW.employee_id;
    END IF;
    RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. org_unit_placements: which 법인 / 사업장 an OrgUnit sits in. A SITE unit
--    that represents a 사업장 is drawn AS that 사업장 (represents_workplace).
CREATE TABLE org_unit_placements (
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                   UUID        NOT NULL DEFAULT gen_random_uuid(),
    org_unit_id          UUID        NOT NULL,
    legal_entity_id      UUID        NULL,
    workplace_id         UUID        NULL,
    represents_workplace BOOLEAN     NOT NULL DEFAULT false,
    valid_from           DATE        NOT NULL,
    valid_to             DATE        NULL,
    change_mode          TEXT        NOT NULL CHECK (change_mode IN ('SETUP', 'GOVERNED', 'SOLE_HOLDER', 'MIGRATION')),
    actor_id             UUID        NULL,
    command_id           UUID        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, command_id, org_unit_id),
    FOREIGN KEY (org_id, org_unit_id) REFERENCES org_units (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, legal_entity_id) REFERENCES legal_entities (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, workplace_id) REFERENCES workplaces (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT org_unit_placements_period CHECK (valid_to IS NULL OR valid_to > valid_from),
    CONSTRAINT org_unit_placements_shape CHECK (workplace_id IS NULL OR legal_entity_id IS NOT NULL),
    CONSTRAINT org_unit_placements_represents CHECK (NOT represents_workplace OR workplace_id IS NOT NULL),
    CONSTRAINT org_unit_placements_actor CHECK (actor_id IS NOT NULL OR change_mode = 'MIGRATION')
);
CREATE UNIQUE INDEX org_unit_placements_open_uniq
    ON org_unit_placements (org_id, org_unit_id) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX org_unit_placements_represents_uniq
    ON org_unit_placements (org_id, workplace_id) WHERE represents_workplace AND valid_to IS NULL;

CREATE FUNCTION org_unit_placements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_setting('app.platform_force_remove_org', true) = 'on' THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'org_unit_placements is append-only';
    END IF;
    IF (NEW.org_id, NEW.id, NEW.org_unit_id, NEW.legal_entity_id, NEW.workplace_id,
        NEW.represents_workplace, NEW.valid_from, NEW.change_mode, NEW.actor_id, NEW.command_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.org_id, OLD.id, OLD.org_unit_id, OLD.legal_entity_id, OLD.workplace_id,
        OLD.represents_workplace, OLD.valid_from, OLD.change_mode, OLD.actor_id, OLD.command_id, OLD.created_at)
       OR (OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to) THEN
        RAISE EXCEPTION 'org_unit_placements rows only close once (id=%)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION employment_assignments_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('app.platform_force_remove_org', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'employment_assignments is append-only';
END $$;

-- ---------------------------------------------------------------------------
-- 3. One-time data migration (before RLS is enabled on the new tables; the
--    cross-tenant reads need row security off, 0225 precedent).
DO $$
DECLARE
    t        RECORD;
    s        RECORD;
    v_entity UUID;
    v_reg    UUID;
    v_wp     UUID;
    v_first  UUID;
    v_count  INTEGER;
    v_branch UUID;
    v_today  DATE := (now() AT TIME ZONE 'Asia/Seoul')::date;
    v_since  DATE;
    v_snap   JSONB;
BEGIN
    SET LOCAL row_security = off;

    FOR t IN
        SELECT o.id AS org_id, o.name AS org_name,
               (SELECT cr.attributes ->> 'legal_name' FROM company_revisions cr
                 WHERE cr.org_id = o.id ORDER BY cr.version DESC LIMIT 1) AS legal_name,
               (SELECT regexp_replace(COALESCE(cr.attributes ->> 'reg_no', ''), '[^0-9]', '', 'g')
                  FROM company_revisions cr
                 WHERE cr.org_id = o.id ORDER BY cr.version DESC LIMIT 1) AS reg_digits,
               (SELECT p.phase FROM tenant_phase p WHERE p.org_id = o.id) AS phase
        FROM organizations o
        WHERE o.id <> '00000000-0000-0000-0000-00000000face'::uuid
          AND NOT EXISTS (SELECT 1 FROM legal_entities le WHERE le.org_id = o.id)
          AND (EXISTS (SELECT 1 FROM employees e WHERE e.org_id = o.id)
               OR EXISTS (SELECT 1 FROM company_revisions cr WHERE cr.org_id = o.id)
               OR EXISTS (SELECT 1 FROM org_unit_revisions r
                           WHERE r.org_id = o.id AND r.attributes ->> 'kind' = 'site'))
        ORDER BY o.id
    LOOP
        v_snap := jsonb_build_object('phase', COALESCE(t.phase, 'OPERATING'), 'source', 'migration_employment_assignments');
        -- INTEG-3: the migrated records start no later than the tenant's
        -- earliest employment (the date the assignments below start from),
        -- so no live assignment predates its 법인 / 사업장. Per tenant, not
        -- per unit: one date for every migrated first record.
        SELECT LEAST(v_today, min(COALESCE(entity_try_iso_date(e.hire_date), (e.created_at AT TIME ZONE 'Asia/Seoul')::date)))
          INTO v_since FROM employees e WHERE e.org_id = t.org_id;
        v_since := COALESCE(v_since, v_today);

        INSERT INTO legal_entities (org_id, needs_confirmation, created_change_mode)
        VALUES (t.org_id, true, 'MIGRATION') RETURNING id INTO v_entity;
        INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, effective_from, name,
            change_mode, reason_code, payload_digest, settings_snapshot, command_id)
        VALUES (t.org_id, v_entity, 1, v_since, left(COALESCE(NULLIF(btrim(t.legal_name), ''), t.org_name), 200),
            'MIGRATION', 'MIGRATION_INITIAL',
            sha256(convert_to(jsonb_build_object('entity', v_entity, 'name', COALESCE(t.legal_name, t.org_name))::text, 'UTF8')),
            v_snap, gen_random_uuid());

        v_reg := NULL;
        IF t.reg_digits ~ '^[0-9]{10}$' AND t.reg_digits <> '0000000000' THEN
            INSERT INTO business_registrations (org_id, legal_entity_id, brn, needs_confirmation,
                unverified_reason, created_change_mode)
            VALUES (t.org_id, v_entity, t.reg_digits, true, 'NOT_CHECKED', 'MIGRATION')
            RETURNING id INTO v_reg;
            INSERT INTO business_registration_revisions (org_id, registration_id, version, effective_from,
                trade_name, status, change_mode, reason_code, payload_digest, settings_snapshot, command_id)
            VALUES (t.org_id, v_reg, 1, v_since, left(COALESCE(NULLIF(btrim(t.legal_name), ''), t.org_name), 200),
                'CONTINUING', 'MIGRATION', 'MIGRATION_INITIAL',
                sha256(convert_to(jsonb_build_object('registration', v_reg)::text, 'UTF8')), v_snap, gen_random_uuid());
        END IF;

        -- Workplaces: one per active SITE unit, else one named after the entity.
        v_first := NULL;
        FOR s IN
            SELECT DISTINCT ON (r.org_unit_id) r.org_unit_id, r.attributes ->> 'name' AS name,
                   r.attributes ->> 'status' AS status, r.attributes ->> 'kind' AS kind
            FROM org_unit_revisions r
            WHERE r.org_id = t.org_id
            ORDER BY r.org_unit_id, r.version DESC
        LOOP
            CONTINUE WHEN s.kind IS DISTINCT FROM 'site' OR s.status = 'dissolved';
            INSERT INTO workplaces (org_id, legal_entity_id, needs_confirmation, created_change_mode)
            VALUES (t.org_id, v_entity, true, 'MIGRATION') RETURNING id INTO v_wp;
            INSERT INTO workplace_revisions (org_id, workplace_id, version, effective_from, name, status,
                change_mode, reason_code, payload_digest, settings_snapshot, command_id)
            VALUES (t.org_id, v_wp, 1, v_since, left(COALESCE(NULLIF(btrim(s.name), ''), t.org_name), 200),
                'CONTINUING', 'MIGRATION', 'MIGRATION_FROM_SITE',
                sha256(convert_to(jsonb_build_object('workplace', v_wp, 'site', s.org_unit_id)::text, 'UTF8')), v_snap, gen_random_uuid());
            INSERT INTO org_unit_placements (org_id, org_unit_id, legal_entity_id, workplace_id,
                represents_workplace, valid_from, change_mode, command_id)
            VALUES (t.org_id, s.org_unit_id, v_entity, v_wp, true, v_since, 'MIGRATION', gen_random_uuid());
            v_first := COALESCE(v_first, v_wp);
        END LOOP;
        IF v_first IS NULL THEN
            INSERT INTO workplaces (org_id, legal_entity_id, needs_confirmation, created_change_mode)
            VALUES (t.org_id, v_entity, true, 'MIGRATION') RETURNING id INTO v_first;
            INSERT INTO workplace_revisions (org_id, workplace_id, version, effective_from, name, status,
                change_mode, reason_code, payload_digest, settings_snapshot, command_id)
            VALUES (t.org_id, v_first, 1, v_since, left(COALESCE(NULLIF(btrim(t.legal_name), ''), t.org_name), 200),
                'CONTINUING', 'MIGRATION', 'MIGRATION_INITIAL',
                sha256(convert_to(jsonb_build_object('workplace', v_first)::text, 'UTF8')), v_snap, gen_random_uuid());
        END IF;

        SELECT count(*) INTO v_count FROM workplaces w WHERE w.org_id = t.org_id;
        -- Bind the tenant's only branch when there is exactly one workplace;
        -- otherwise the cleanup screen maps branches per distinct branch (E-14).
        IF v_count = 1 THEN
            SELECT b.id INTO v_branch FROM branches b
            WHERE b.org_id = t.org_id AND b.deactivated_at IS NULL;
            IF (SELECT count(*) FROM branches b WHERE b.org_id = t.org_id AND b.deactivated_at IS NULL) = 1 THEN
                UPDATE workplaces SET default_branch_id = v_branch WHERE org_id = t.org_id AND id = v_first;
            END IF;
            IF v_reg IS NOT NULL THEN
                UPDATE workplaces SET registration_id = v_reg WHERE org_id = t.org_id AND id = v_first;
            END IF;
        END IF;
        UPDATE legal_entities SET primary_workplace_id = v_first WHERE org_id = t.org_id AND id = v_entity;
        IF v_reg IS NOT NULL THEN
            UPDATE business_registrations SET holder_workplace_id = v_first WHERE org_id = t.org_id AND id = v_reg;
        END IF;
        -- Root SITE units are placed above; departments inherit through the tree.
    END LOOP;

    -- Employment: one live assignment per employee that has none. The entity
    -- maps only when the tenant has exactly one distinct company text and one
    -- entity (nothing to choose); the workplace maps from the employee's SITE
    -- ancestor, or the tenant's only workplace. Anything else is UNMAPPED and
    -- surfaces as 「회사 이름 정리」.
    WITH RECURSIVE latest AS (
        SELECT DISTINCT ON (r.org_id, r.org_unit_id) r.org_id, r.org_unit_id,
               NULLIF(r.attributes ->> 'parent_id', '')::uuid AS parent_id, r.attributes ->> 'kind' AS kind
        FROM org_unit_revisions r
        ORDER BY r.org_id, r.org_unit_id, r.version DESC
    ), walk AS (
        SELECT e.org_id, e.id AS employee_id, l.org_unit_id, l.parent_id, l.kind, 0 AS depth
        FROM employees e JOIN latest l ON l.org_id = e.org_id AND l.org_unit_id = e.org_unit_id
        UNION ALL
        SELECT w.org_id, w.employee_id, l.org_unit_id, l.parent_id, l.kind, w.depth + 1
        FROM walk w JOIN latest l ON l.org_id = w.org_id AND l.org_unit_id = w.parent_id
        WHERE w.kind IS DISTINCT FROM 'site' AND w.depth < 32
    ), site_of AS (
        SELECT DISTINCT ON (org_id, employee_id) org_id, employee_id, org_unit_id AS site_unit_id
        FROM walk WHERE kind = 'site'
        ORDER BY org_id, employee_id, depth
    ), tenant_facts AS (
        SELECT e.org_id,
               count(DISTINCT NULLIF(btrim(e.company), '')) AS company_texts,
               (SELECT count(*) FROM legal_entities le WHERE le.org_id = e.org_id) AS entities,
               (SELECT min(le.id::text)::uuid FROM legal_entities le WHERE le.org_id = e.org_id) AS entity_id,
               (SELECT count(*) FROM workplaces w WHERE w.org_id = e.org_id) AS workplaces,
               (SELECT min(w.id::text)::uuid FROM workplaces w WHERE w.org_id = e.org_id) AS workplace_id
        FROM employees e GROUP BY e.org_id
    ), mapped AS (
        SELECT e.org_id, e.id AS employee_id,
               CASE WHEN f.company_texts = 1 AND f.entities = 1 THEN f.entity_id END AS legal_entity_id,
               COALESCE(p.workplace_id, CASE WHEN f.workplaces = 1 THEN f.workplace_id END) AS workplace_id,
               COALESCE(entity_try_iso_date(e.hire_date), (e.created_at AT TIME ZONE 'Asia/Seoul')::date) AS valid_from,
               CASE WHEN e.employment_status = 'EXITED' THEN entity_try_iso_date(e.exit_date) + 1 END AS valid_to
        FROM employees e
        JOIN tenant_facts f ON f.org_id = e.org_id
        LEFT JOIN site_of so ON so.org_id = e.org_id AND so.employee_id = e.id
        LEFT JOIN org_unit_placements p ON p.org_id = e.org_id AND p.org_unit_id = so.site_unit_id
             AND p.represents_workplace AND p.valid_to IS NULL
        WHERE NOT EXISTS (SELECT 1 FROM employment_assignments a WHERE a.org_id = e.org_id AND a.employee_id = e.id)
    )
    INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, valid_to, cause, command_id)
    SELECT org_id, employee_id, legal_entity_id,
           CASE WHEN legal_entity_id IS NULL THEN NULL ELSE workplace_id END,
           valid_from,
           CASE WHEN valid_to > valid_from THEN valid_to END,
           CASE WHEN legal_entity_id IS NULL THEN 'MIGRATION_UNMAPPED' ELSE 'MIGRATION' END,
           gen_random_uuid()
    FROM mapped;
END
$$;

-- ---------------------------------------------------------------------------

-- 4. RLS, triggers, grants, classification

-- employment_assignments
ALTER TABLE employment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employment_assignments
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_employment_assignments_org_immutable BEFORE UPDATE ON employment_assignments
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_employment_assignments_guard BEFORE INSERT OR UPDATE ON employment_assignments
    FOR EACH ROW EXECUTE FUNCTION employment_assignments_guard();
CREATE TRIGGER trg_employment_assignments_no_delete BEFORE DELETE ON employment_assignments
    FOR EACH ROW EXECUTE FUNCTION employment_assignments_no_delete();
REVOKE ALL PRIVILEGES ON employment_assignments FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON employment_assignments TO console_rt;
GRANT UPDATE (valid_to, superseded_at) ON employment_assignments TO console_rt;
COMMENT ON TABLE employment_assignments IS 'Id-typed employer (법인) and 사업장 history of an employee; employees.company text is a display snapshot only';
COMMENT ON COLUMN employment_assignments.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employment_assignments.id IS 'pd:none — row id';
COMMENT ON COLUMN employment_assignments.employee_id IS 'pd:personal — the employee';
COMMENT ON COLUMN employment_assignments.legal_entity_id IS 'pd:personal — the employee''s employer of record (법인)';
COMMENT ON COLUMN employment_assignments.workplace_id IS 'pd:personal — the employee''s 사업장';
COMMENT ON COLUMN employment_assignments.valid_from IS 'pd:personal — first day of this assignment (KST)';
COMMENT ON COLUMN employment_assignments.valid_to IS 'pd:personal — exclusive end day; NULL = open';
COMMENT ON COLUMN employment_assignments.cause IS 'pd:none — HIRE | TRANSFER | GROUP_TRANSFER | CORRECTION | SETUP_BIND | MIGRATION | MIGRATION_UNMAPPED';
COMMENT ON COLUMN employment_assignments.group_transfer_id IS 'pd:none — links the exit and re-hire halves of a 전적';
COMMENT ON COLUMN employment_assignments.superseded_at IS 'pd:none — set once when a correction replaced this row (history kept)';
COMMENT ON COLUMN employment_assignments.actor_id IS 'pd:personal — user who wrote the row (NULL only for a migration)';
COMMENT ON COLUMN employment_assignments.command_id IS 'pd:none — the accepted command (Idempotency-Key) that wrote the row';
COMMENT ON COLUMN employment_assignments.created_at IS 'pd:none — row creation time';

-- org_unit_placements
ALTER TABLE org_unit_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_unit_placements FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org_unit_placements
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_org_unit_placements_org_immutable BEFORE UPDATE ON org_unit_placements
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_org_unit_placements_guard BEFORE UPDATE OR DELETE ON org_unit_placements
    FOR EACH ROW EXECUTE FUNCTION org_unit_placements_guard();
REVOKE ALL PRIVILEGES ON org_unit_placements FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON org_unit_placements TO console_rt;
GRANT UPDATE (valid_to) ON org_unit_placements TO console_rt;
COMMENT ON TABLE org_unit_placements IS 'Which 법인 / 사업장 an OrgUnit sits in; represents_workplace draws a SITE unit as its 사업장';
COMMENT ON COLUMN org_unit_placements.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN org_unit_placements.id IS 'pd:none — row id';
COMMENT ON COLUMN org_unit_placements.org_unit_id IS 'pd:none — the OrgUnit';
COMMENT ON COLUMN org_unit_placements.legal_entity_id IS 'pd:none — 법인 the unit sits in; NULL = spans entities';
COMMENT ON COLUMN org_unit_placements.workplace_id IS 'pd:none — 사업장 the unit sits in; NULL = spans the entity''s 사업장';
COMMENT ON COLUMN org_unit_placements.represents_workplace IS 'pd:none — this (SITE) unit is the 사업장 itself in the org tree';
COMMENT ON COLUMN org_unit_placements.valid_from IS 'pd:none — first day (KST)';
COMMENT ON COLUMN org_unit_placements.valid_to IS 'pd:none — exclusive end day; NULL = open';
COMMENT ON COLUMN org_unit_placements.change_mode IS 'pd:none — SETUP | GOVERNED | SOLE_HOLDER | MIGRATION';
COMMENT ON COLUMN org_unit_placements.actor_id IS 'pd:personal — user who wrote the row (NULL only for a migration)';
COMMENT ON COLUMN org_unit_placements.command_id IS 'pd:none — the accepted command (Idempotency-Key) that wrote the row';
COMMENT ON COLUMN org_unit_placements.created_at IS 'pd:none — row creation time';
