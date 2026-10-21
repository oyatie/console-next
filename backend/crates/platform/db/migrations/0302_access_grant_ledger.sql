-- BE-ROLES (decision #26): every access grant write lands in the BW-29 grant
-- ledger (GR-17, kept ≥ 3 years). The ledger gains the ACCESS_GRANT kind and a
-- REDATED event (an end date moved); rows come from a trigger, never from the
-- serving role (its notice-only INSERT policy stays).
--
-- Lane number (head+2 of integ/mr-b9); INTEG renumbers at merge.
SET LOCAL lock_timeout = '2s';

ALTER TABLE authz_grant_ledger DROP CONSTRAINT authz_grant_ledger_grant_kind_check,
    ADD CONSTRAINT authz_grant_ledger_grant_kind_check
        CHECK (grant_kind IN ('ACCOUNT', 'SYSTEM_ROLE', 'POLICY_ROLE', 'ACCESS_GRANT'));
ALTER TABLE authz_grant_ledger DROP CONSTRAINT authz_grant_ledger_event_check,
    ADD CONSTRAINT authz_grant_ledger_event_check
        CHECK (event IN ('GRANTED', 'REVOKED', 'NOTICE_DELIVERED', 'REDATED'));

CREATE FUNCTION authz_grant_ledger_access_grants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    ev TEXT;
BEGIN
    IF authz_grant_ledger_skip() THEN RETURN NULL; END IF;
    ev := CASE
        WHEN TG_OP = 'INSERT' THEN 'GRANTED'
        WHEN NEW.status = 'REVOKED' THEN 'REVOKED'
        ELSE 'REDATED' END;
    INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, actor_id, source)
    VALUES (NEW.org_id, NEW.account_id, 'ACCESS_GRANT', NEW.id::text, ev,
            COALESCE(authz_grant_ledger_actor(), NEW.revoked_by, NEW.granted_by), 'TRIGGER');
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION authz_grant_ledger_access_grants() FROM PUBLIC;
CREATE TRIGGER trg_authz_grant_ledger_access_grants AFTER INSERT OR UPDATE ON access_grants
    FOR EACH ROW EXECUTE FUNCTION authz_grant_ledger_access_grants();
