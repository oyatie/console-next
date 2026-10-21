-- Tenant setup phase: SETUP → (운영 시작, one-way) → OPERATING (design §5;
-- challenge B-5.1, B-5.4).
--
-- Lane number (head+1 of trunk dccb092); INTEG renumbers at merge.
--
-- console_rt cannot write `organizations` (0031), so the phase lives here.
-- Writer crate: console-onboarding-adapter-postgres (go-live), plus the
-- organizations AFTER INSERT trigger below (every creation path, including
-- platform_create_organization, opens a tenant in SETUP).
--
-- Fail closed: readers treat a MISSING row as OPERATING (kernel
-- `TenantPhase::from_db`). The trigger guarantees new tenants have a row; the
-- backfill below gives every existing tenant one, computed ONCE and never
-- recomputed on re-run (a tenant whose employees all exited must not re-enter
-- SETUP).
--
-- One-way at the database: OPERATING → SETUP is refused, and the go-live
-- columns are write-once.
SET LOCAL lock_timeout = '2s';

CREATE TABLE tenant_phase (
    org_id                 UUID        PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    phase                  TEXT        NOT NULL CHECK (phase IN ('SETUP', 'OPERATING')),
    setup_opened_at        TIMESTAMPTZ NULL,
    go_live_at             TIMESTAMPTZ NULL,
    go_live_by             UUID        NULL,
    go_live_preview_digest TEXT        NULL CHECK (go_live_preview_digest IS NULL OR go_live_preview_digest ~ '^[a-f0-9]{64}$'),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (go_live_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    -- The go-live columns travel together, and SETUP never carries them. A
    -- backfilled OPERATING tenant has none (it never went through 운영 시작).
    CONSTRAINT tenant_phase_go_live_shape CHECK (
        (go_live_at IS NULL) = (go_live_by IS NULL)
        AND (go_live_at IS NULL) = (go_live_preview_digest IS NULL)
        AND (phase = 'OPERATING' OR go_live_at IS NULL)
    )
);

CREATE FUNCTION tenant_phase_one_way() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.phase = 'OPERATING' AND NEW.phase <> 'OPERATING' THEN
        RAISE EXCEPTION 'tenant % is OPERATING; the setup phase never reopens', OLD.org_id;
    END IF;
    IF OLD.go_live_at IS NOT NULL
       AND (NEW.go_live_at, NEW.go_live_by, NEW.go_live_preview_digest)
           IS DISTINCT FROM (OLD.go_live_at, OLD.go_live_by, OLD.go_live_preview_digest) THEN
        RAISE EXCEPTION 'tenant % go-live record is write-once', OLD.org_id;
    END IF;
    IF (NEW.org_id, NEW.setup_opened_at, NEW.created_at)
       IS DISTINCT FROM (OLD.org_id, OLD.setup_opened_at, OLD.created_at) THEN
        RAISE EXCEPTION 'tenant_phase identity columns are immutable (org=%)', OLD.org_id;
    END IF;
    RETURN NEW;
END $$;

-- Every new organization opens in SETUP. The trigger arms app.current_org to
-- the new tenant for its own INSERT (FORCE RLS applies to the owner too) and
-- restores the caller's value, so an enclosing transaction keeps its tenant.
CREATE FUNCTION organizations_after_insert_open_setup() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    prev TEXT := current_setting('app.current_org', true);
BEGIN
    PERFORM set_config('app.current_org', NEW.id::text, true);
    INSERT INTO tenant_phase (org_id, phase, setup_opened_at) VALUES (NEW.id, 'SETUP', now())
        ON CONFLICT (org_id) DO NOTHING;
    INSERT INTO tenant_phase_events (org_id, kind, payload)
        VALUES (NEW.id, 'SETUP_OPENED', '{}'::jsonb);
    PERFORM set_config('app.current_org', COALESCE(prev, ''), true);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION organizations_after_insert_open_setup() FROM PUBLIC;

CREATE TABLE tenant_phase_events (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id         UUID        NOT NULL DEFAULT gen_random_uuid(),
    kind       TEXT        NOT NULL CHECK (kind IN (
                   'SETUP_OPENED', 'BACKFILLED', 'GO_LIVE',
                   'TERMS_ACCEPTED', 'ORG_STEP_SKIPPED', 'EMPLOYEES_STEP_DEFERRED')),
    actor_id   UUID        NULL,
    payload    JSONB       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT tenant_phase_events_actor CHECK ((kind IN ('SETUP_OPENED', 'BACKFILLED')) = (actor_id IS NULL)),
    -- 이용약관 is accepted once per tenant by the contracting admin (decisions #3);
    -- the version accepted is part of the record.
    CONSTRAINT tenant_phase_events_terms CHECK (
        kind <> 'TERMS_ACCEPTED' OR (payload ? 'terms_version' AND char_length(payload ->> 'terms_version') BETWEEN 1 AND 40)
    )
);

CREATE FUNCTION tenant_phase_events_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'tenant_phase_events is append-only';
END $$;

CREATE TRIGGER trg_organizations_after_insert_open_setup
    AFTER INSERT ON organizations
    FOR EACH ROW EXECUTE FUNCTION organizations_after_insert_open_setup();

-- Backfill, once: SETUP when the tenant has no non-EXITED employee and no
-- APPLIED org change, else OPERATING. Never recomputed (ON CONFLICT DO
-- NOTHING). Cross-tenant read, so row security is off for this migration's
-- transaction (0225 precedent): a role that cannot bypass RLS fails loudly
-- here instead of silently reading zero employees and opening every tenant
-- in SETUP.
DO $$
BEGIN
    SET LOCAL row_security = off;
    INSERT INTO tenant_phase (org_id, phase, setup_opened_at)
    SELECT o.id,
           CASE WHEN NOT EXISTS (
                    SELECT 1 FROM employees e
                    WHERE e.org_id = o.id AND e.employment_status <> 'EXITED')
                 AND NOT EXISTS (
                    SELECT 1 FROM org_change_requests r
                    WHERE r.org_id = o.id AND r.status = 'APPLIED')
                THEN 'SETUP' ELSE 'OPERATING' END,
           NULL
    FROM organizations o
    ON CONFLICT (org_id) DO NOTHING;
    INSERT INTO tenant_phase_events (org_id, kind, payload)
    SELECT p.org_id, 'BACKFILLED', jsonb_build_object('phase', p.phase)
    FROM tenant_phase p
    WHERE NOT EXISTS (SELECT 1 FROM tenant_phase_events e WHERE e.org_id = p.org_id);
END
$$;

-- ---------------------------------------------------------------------------
-- tenant_phase
ALTER TABLE tenant_phase ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_phase FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_phase
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_tenant_phase_org_immutable BEFORE UPDATE ON tenant_phase
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
CREATE TRIGGER trg_tenant_phase_one_way BEFORE UPDATE ON tenant_phase
    FOR EACH ROW EXECUTE FUNCTION tenant_phase_one_way();
REVOKE ALL PRIVILEGES ON tenant_phase FROM PUBLIC, console_rt;
GRANT SELECT ON tenant_phase TO console_rt;
GRANT UPDATE (phase, go_live_at, go_live_by, go_live_preview_digest) ON tenant_phase TO console_rt;
COMMENT ON TABLE tenant_phase IS 'Tenant setup phase (SETUP | OPERATING); a missing row reads as OPERATING';
COMMENT ON COLUMN tenant_phase.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN tenant_phase.phase IS 'pd:none — SETUP (setup writes apply immediately, audited) | OPERATING (governed)';
COMMENT ON COLUMN tenant_phase.setup_opened_at IS 'pd:none — when SETUP opened; NULL for a tenant backfilled as OPERATING';
COMMENT ON COLUMN tenant_phase.go_live_at IS 'pd:none — 운영 시작 time (write-once)';
COMMENT ON COLUMN tenant_phase.go_live_by IS 'pd:personal — SUPER_ADMIN who started operation (write-once)';
COMMENT ON COLUMN tenant_phase.go_live_preview_digest IS 'pd:none — digest of the go-live preview the actor confirmed';
COMMENT ON COLUMN tenant_phase.created_at IS 'pd:none — row creation time';

-- tenant_phase_events
ALTER TABLE tenant_phase_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_phase_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_phase_events
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_tenant_phase_events_no_update BEFORE UPDATE ON tenant_phase_events
    FOR EACH ROW EXECUTE FUNCTION tenant_phase_events_no_update();
REVOKE ALL PRIVILEGES ON tenant_phase_events FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON tenant_phase_events TO console_rt;
COMMENT ON TABLE tenant_phase_events IS 'Append-only history of a tenant phase and its setup-rail choices (terms accepted, steps skipped)';
COMMENT ON COLUMN tenant_phase_events.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN tenant_phase_events.id IS 'pd:none — event id';
COMMENT ON COLUMN tenant_phase_events.kind IS 'pd:none — SETUP_OPENED | BACKFILLED | GO_LIVE | TERMS_ACCEPTED | ORG_STEP_SKIPPED | EMPLOYEES_STEP_DEFERRED';
COMMENT ON COLUMN tenant_phase_events.actor_id IS 'pd:personal — actor of a person-made event (go-live, terms, step choices)';
COMMENT ON COLUMN tenant_phase_events.payload IS 'pd:none — event facts (counts, preview digest, phase, terms version)';
COMMENT ON COLUMN tenant_phase_events.created_at IS 'pd:none — event time';
