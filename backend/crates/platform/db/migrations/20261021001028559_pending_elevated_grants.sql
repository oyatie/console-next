-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only; rollback retains pending rows, which old binaries cannot authorize.
ALTER TABLE access_grants DROP CONSTRAINT access_grants_status_check;
ALTER TABLE access_grants ADD CONSTRAINT access_grants_status_check CHECK (status IN ('ACTIVE', 'PENDING', 'REVOKED'));
CREATE TABLE user_role_grants_pending (
    org_id UUID NOT NULL,
    grant_id UUID NOT NULL,
    activates_at TIMESTAMPTZ NOT NULL,
    activated_at TIMESTAMPTZ,
    PRIMARY KEY (org_id, grant_id),
    FOREIGN KEY (org_id, grant_id) REFERENCES access_grants (org_id, id) ON DELETE CASCADE
);
CREATE INDEX user_role_grants_pending_due ON user_role_grants_pending (activates_at) WHERE activated_at IS NULL;
ALTER TABLE user_role_grants_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role_grants_pending FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON user_role_grants_pending
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON user_role_grants_pending FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON user_role_grants_pending TO console_rt;
GRANT UPDATE (activated_at) ON user_role_grants_pending TO console_rt;
COMMENT ON TABLE user_role_grants_pending IS 'Delayed elevated grants; active grants alone authorize. Cancellation revokes the linked grant.';
COMMENT ON COLUMN user_role_grants_pending.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN user_role_grants_pending.grant_id IS 'pd:none — linked grant';
COMMENT ON COLUMN user_role_grants_pending.activates_at IS 'pd:none — configured activation deadline';
COMMENT ON COLUMN user_role_grants_pending.activated_at IS 'pd:none — worker activation instant';

CREATE OR REPLACE FUNCTION authz_grant_ledger_access_grants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    ev TEXT;
BEGIN
    IF authz_grant_ledger_skip() THEN RETURN NULL; END IF;
    IF TG_OP = 'INSERT' AND NEW.status = 'PENDING' THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'PENDING' AND NEW.status <> 'ACTIVE' THEN RETURN NULL; END IF;
    ev := CASE
        WHEN TG_OP = 'INSERT' THEN 'GRANTED'
        WHEN OLD.status = 'PENDING' AND NEW.status = 'ACTIVE' THEN 'GRANTED'
        WHEN NEW.status = 'REVOKED' THEN 'REVOKED'
        ELSE 'REDATED' END;
    INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, actor_id, source)
    VALUES (NEW.org_id, NEW.account_id, 'ACCESS_GRANT', NEW.id::text, ev,
            COALESCE(authz_grant_ledger_actor(), NEW.revoked_by, NEW.granted_by), 'TRIGGER');
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION access_grants_guard() RETURNS trigger
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
    IF NEW.status IN ('ACTIVE', 'PENDING') THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('access_grants:' || NEW.account_id::text, 0));
        IF EXISTS (
            SELECT 1 FROM access_grants g
            WHERE g.org_id = NEW.org_id AND g.account_id = NEW.account_id AND g.role_id = NEW.role_id
              AND g.id <> NEW.id AND g.status IN ('ACTIVE', 'PENDING') AND g.scope_kind = NEW.scope_kind
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
