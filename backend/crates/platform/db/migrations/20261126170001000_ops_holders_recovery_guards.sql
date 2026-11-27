-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Enforce at-most-two ops account holders per tenant, unique recovery artifacts, and combined invite idempotency.
-- contract-of: 20261126170000000
SET LOCAL lock_timeout = '2s';

DROP INDEX IF EXISTS users_one_tenant_ops;

CREATE OR REPLACE FUNCTION enforce_ops_holder_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    prev        TEXT := current_setting('app.current_org', true);
    other_count INTEGER;
BEGIN
    IF NOT (NEW.is_tenant_ops AND NEW.is_active) THEN
        RETURN NEW;
    END IF;
    PERFORM set_config('app.current_org', NEW.org_id::text, true);
    SELECT count(*)
      INTO other_count
      FROM public.users
     WHERE org_id = NEW.org_id
       AND is_tenant_ops
       AND is_active
       AND id <> NEW.id;
    PERFORM set_config('app.current_org', COALESCE(prev, ''), true);
    IF other_count >= 2 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            CONSTRAINT = 'ops_holder_limit_reached',
            MESSAGE = format('tenant %s cannot have more than 2 active ops account holders', NEW.org_id);
    END IF;
    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION enforce_ops_holder_limit() FROM PUBLIC;

CREATE TRIGGER trg_users_ops_holder_limit
    BEFORE INSERT OR UPDATE OF is_tenant_ops, is_active ON users
    FOR EACH ROW
    WHEN (NEW.is_tenant_ops AND NEW.is_active)
    EXECUTE FUNCTION enforce_ops_holder_limit();

CREATE UNIQUE INDEX ops_account_holders_active_unique
    ON ops_account_holders (org_id, user_id)
    WHERE released_at IS NULL;

CREATE UNIQUE INDEX recovery_contacts_user_unique
    ON recovery_contacts (org_id, user_id);

CREATE UNIQUE INDEX recovery_codes_hash_unique
    ON recovery_codes (code_hash);

CREATE UNIQUE INDEX recovery_codes_batch_slot_unique
    ON recovery_codes (org_id, user_id, batch_id, code_index);

CREATE TRIGGER ops_account_holders_org_immutable
    BEFORE UPDATE ON ops_account_holders
    FOR EACH ROW
    EXECUTE FUNCTION enforce_org_id_immutable();

CREATE TRIGGER recovery_contacts_org_immutable
    BEFORE UPDATE ON recovery_contacts
    FOR EACH ROW
    EXECUTE FUNCTION enforce_org_id_immutable();

CREATE TRIGGER recovery_codes_org_immutable
    BEFORE UPDATE ON recovery_codes
    FOR EACH ROW
    EXECUTE FUNCTION enforce_org_id_immutable();

CREATE TRIGGER recovery_contact_challenges_org_immutable
    BEFORE UPDATE ON recovery_contact_challenges
    FOR EACH ROW
    EXECUTE FUNCTION enforce_org_id_immutable();

CREATE OR REPLACE FUNCTION platform_resolve_recovery_code_org(p_code_hash BYTEA)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT org_id
      FROM recovery_codes
     WHERE code_hash = p_code_hash
       AND consumed_at IS NULL
       AND revoked_at IS NULL
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION platform_resolve_recovery_code_org(BYTEA) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_resolve_recovery_code_org(BYTEA) TO console_rt;

CREATE OR REPLACE FUNCTION platform_resolve_recovery_identifier(p_login TEXT, p_slug TEXT)
RETURNS TABLE (org_id UUID, user_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT o.id, u.id
      FROM organizations o
      JOIN user_sign_in_ids s ON s.org_id = o.id AND s.retired_at IS NULL AND lower(s.login) = lower(p_login)
      JOIN users u ON u.org_id = o.id AND u.id = s.user_id AND u.is_active AND u.is_tenant_ops
     WHERE lower(o.slug) = lower(p_slug)
       AND o.status = 'ACTIVE'
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION platform_resolve_recovery_identifier(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_resolve_recovery_identifier(TEXT, TEXT) TO console_rt;

DO $$
DECLARE
    u    RECORD;
    prev TEXT := current_setting('app.current_org', true);
BEGIN
    FOR u IN
        SELECT org_id, id, created_at
          FROM public.users
         WHERE is_tenant_ops
         ORDER BY org_id, created_at, id
    LOOP
        PERFORM set_config('app.current_org', u.org_id::text, true);
        INSERT INTO public.ops_account_holders (org_id, user_id, designated_at)
        VALUES (u.org_id, u.id, u.created_at)
        ON CONFLICT (org_id, user_id) WHERE released_at IS NULL DO NOTHING;
    END LOOP;
    PERFORM set_config('app.current_org', COALESCE(prev, ''), true);
END
$$;

ALTER TABLE api_idempotency_keys
    DROP CONSTRAINT IF EXISTS api_idempotency_keys_operation_check,
    ADD CONSTRAINT api_idempotency_keys_operation_check CHECK (operation IN (
        'users.create', 'access.invites.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'hr.exit_case.bulk_create', 'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve', 'period_lock.unlock_reject',
        'employee.correction.bulk', 'appointment_notice.issue', 'tenant.domain.request', 'platform.tenant.rename',
        'certificate.issue', 'certificate.void', 'certificate.reissue',
        'platform.tenant.ops_recovery.open', 'platform.tenant.ops_recovery.approve',
        'platform.tenant.ops_recovery.issue', 'platform.tenant.ops_recovery.cancel',
        'employee_import.rollback', 'access_log_review.start', 'access_log_review.finding',
        'access_log_review.complete'
    )) NOT VALID;
ALTER TABLE api_idempotency_keys
    VALIDATE CONSTRAINT api_idempotency_keys_operation_check;
