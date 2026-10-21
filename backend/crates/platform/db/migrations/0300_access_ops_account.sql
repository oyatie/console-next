-- BE-ROLES (decision #26 pilot roles slice; access-model §2.4, §11.2, GR-3).
--
-- The tenant ops account: exactly one per tenant, break-glass, never a role.
-- `users.is_tenant_ops` marks it; a partial unique index keeps it to one; the
-- deferred constraint trigger `tenant_keeps_ops` refuses any commit that leaves
-- a tenant which had an ops account without an ACTIVE one (unset, deactivated
-- or deleted) — the lockout invariant. A handover (unset A, set B) commits in
-- one transaction and passes. Tenant removal (the organization row is gone at
-- commit, or the force-remove GUC is on) is not a lockout.
--
-- Every request the ops account makes is logged in `access_ops_usage`
-- (「ops 사용 기록」): the serving role may only append.
--
-- Lane number (head+1 of integ/mr-b9); INTEG renumbers at merge.
SET LOCAL lock_timeout = '2s';

ALTER TABLE users ADD COLUMN is_tenant_ops BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN users.is_tenant_ops IS 'pd:none — the tenant''s one ops (break-glass) account (access-model §2.4)';
CREATE UNIQUE INDEX users_one_tenant_ops ON users (org_id) WHERE is_tenant_ops;

-- Backfill (access-model §11.2): per tenant, the earliest ACTIVE account the
-- onboarding created as administrator becomes the ops account. This literal is
-- the legacy column's value, read once here; no Rust code reads it for ops.
UPDATE users AS u SET is_tenant_ops = true
FROM (
    SELECT DISTINCT ON (org_id) id
    FROM users
    WHERE is_active AND 'SUPER_ADMIN' = ANY (roles)
      AND org_id <> '00000000-0000-0000-0000-00000000face'::uuid
    ORDER BY org_id, created_at, id
) AS first_admin
WHERE u.id = first_admin.id;

CREATE FUNCTION tenant_keeps_ops() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    prev TEXT := current_setting('app.current_org', true);
    kept BOOLEAN;
BEGIN
    IF current_setting('app.platform_force_remove_org', true) IS NOT DISTINCT FROM 'on' THEN
        RETURN NULL;
    END IF;
    PERFORM set_config('app.current_org', OLD.org_id::text, true);
    SELECT NOT EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id)
        OR EXISTS (SELECT 1 FROM users WHERE org_id = OLD.org_id AND is_tenant_ops AND is_active)
      INTO kept;
    PERFORM set_config('app.current_org', COALESCE(prev, ''), true);
    IF NOT kept THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'tenant_keeps_ops',
            MESSAGE = format('tenant %s would have no active ops account', OLD.org_id);
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION tenant_keeps_ops() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER tenant_keeps_ops AFTER UPDATE OR DELETE ON users
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (OLD.is_tenant_ops)
    EXECUTE FUNCTION tenant_keeps_ops();

-- 「ops 사용 기록」: one row per request the ops account made. No FK to users
-- (tenant removal deletes users first); the org FK cascades like the grant
-- ledger, so a tenant's own usage never makes it non-empty.
CREATE TABLE access_ops_usage (
    org_id            UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id                UUID        NOT NULL DEFAULT gen_random_uuid(),
    account_id        UUID        NOT NULL,
    session_family_id UUID        NULL,
    method            TEXT        NOT NULL CHECK (char_length(method) BETWEEN 1 AND 16),
    path              TEXT        NOT NULL CHECK (char_length(path) BETWEEN 1 AND 512),
    at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id)
);
CREATE INDEX access_ops_usage_recent_idx ON access_ops_usage (org_id, at DESC);

ALTER TABLE access_ops_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_ops_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON access_ops_usage
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL PRIVILEGES ON access_ops_usage FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON access_ops_usage TO console_rt;
COMMENT ON TABLE access_ops_usage IS 'ops 사용 기록: one append-only row per request made by the tenant ops account (decision #26, access-model §2.4)';
COMMENT ON COLUMN access_ops_usage.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN access_ops_usage.id IS 'pd:none — row id';
COMMENT ON COLUMN access_ops_usage.account_id IS 'pd:personal — the ops account that made the request';
COMMENT ON COLUMN access_ops_usage.session_family_id IS 'pd:none — the sign-in session family';
COMMENT ON COLUMN access_ops_usage.method IS 'pd:none — HTTP method';
COMMENT ON COLUMN access_ops_usage.path IS 'pd:none — request path without the query string (ids only)';
COMMENT ON COLUMN access_ops_usage.at IS 'pd:none — request time';
