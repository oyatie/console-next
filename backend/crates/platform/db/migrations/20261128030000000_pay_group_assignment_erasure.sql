-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Enable authorized tenant removal of pay-group assignments before their restrictive parent.
-- contract-of: 20261127040000000
SET LOCAL lock_timeout = '2s';

-- Restrict this exception to the pay-group history tables below. Ordinary writers may
-- set custom GUCs, so the marker alone is insufficient authorization.
CREATE FUNCTION payroll_history_immutable_except_tenant_erase() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('app.platform_force_remove_org', true) = 'on'
       AND current_user = pg_get_userbyid((SELECT proowner FROM pg_proc
           WHERE oid = 'public.platform_force_remove_organization(uuid)'::regprocedure)) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'append-only table % forbids %', TG_TABLE_NAME, TG_OP USING ERRCODE = '25006';
END;
$$;
REVOKE ALL ON FUNCTION payroll_history_immutable_except_tenant_erase() FROM PUBLIC;

DROP TRIGGER trg_employee_pay_group_assignments_no_delete ON employee_pay_group_assignments;
CREATE TRIGGER trg_employee_pay_group_assignments_no_delete
    BEFORE DELETE ON employee_pay_group_assignments
    FOR EACH ROW EXECUTE FUNCTION payroll_history_immutable_except_tenant_erase();
DROP TRIGGER trg_period_locks_no_delete ON period_locks;
CREATE TRIGGER trg_period_locks_no_delete
    BEFORE DELETE ON period_locks
    FOR EACH ROW EXECUTE FUNCTION payroll_history_immutable_except_tenant_erase();
DROP TRIGGER trg_attendance_month_closes_append_only ON attendance_month_closes;
CREATE TRIGGER trg_attendance_month_closes_append_only
    BEFORE UPDATE OR DELETE ON attendance_month_closes
    FOR EACH ROW EXECUTE FUNCTION payroll_history_immutable_except_tenant_erase();
DROP TRIGGER trg_attendance_close_amendments_append_only ON attendance_close_amendments;
CREATE TRIGGER trg_attendance_close_amendments_append_only
    BEFORE UPDATE OR DELETE ON attendance_close_amendments
    FOR EACH ROW EXECUTE FUNCTION payroll_history_immutable_except_tenant_erase();

CREATE OR REPLACE FUNCTION platform_force_remove_direct_org_children(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target RECORD;
BEGIN
    DELETE FROM attendance_close_amendments            WHERE org_id = p_id;
    DELETE FROM attendance_month_closes                WHERE org_id = p_id;
    DELETE FROM period_locks                           WHERE org_id = p_id;
    DELETE FROM employee_pay_group_assignments         WHERE org_id = p_id;
    DELETE FROM payroll_draft_lines                    WHERE org_id = p_id;
    DELETE FROM payroll_draft_runs                     WHERE org_id = p_id;
    DELETE FROM equipment_maintenance_history_costs    WHERE org_id = p_id;
    DELETE FROM equipment_maintenance_history_evidence WHERE org_id = p_id;
    DELETE FROM equipment_maintenance_history          WHERE org_id = p_id;
    DELETE FROM support_session_decisions              WHERE org_id = p_id;
    DELETE FROM support_sessions                       WHERE org_id = p_id;

    FOR target IN
        SELECT child_ns.nspname AS schema_name, child.relname AS relation_name
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS child ON child.oid = fk.conrelid
        JOIN pg_catalog.pg_namespace AS child_ns ON child_ns.oid = child.relnamespace
        JOIN pg_catalog.pg_class AS parent ON parent.oid = fk.confrelid
        JOIN pg_catalog.pg_namespace AS parent_ns ON parent_ns.oid = parent.relnamespace
        JOIN pg_catalog.pg_attribute AS child_attr
          ON child_attr.attrelid = child.oid
         AND child_attr.attnum = fk.conkey[1]
         AND NOT child_attr.attisdropped
        WHERE fk.contype = 'f'
          AND fk.confdeltype IN ('a', 'r')
          AND parent_ns.nspname = 'public'
          AND parent.relname = 'organizations'
          AND child_ns.nspname = 'public'
          AND child.relkind IN ('r', 'p')
          AND child.relname NOT IN (
              'audit_events', 'employees', 'users', 'branches', 'regions'
          )
          AND cardinality(fk.conkey) = 1
          AND child_attr.attname = 'org_id'
        ORDER BY child.oid DESC
    LOOP
        EXECUTE format('DELETE FROM %I.%I WHERE org_id = $1',
                       target.schema_name, target.relation_name)
            USING p_id;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION platform_force_remove_direct_org_children(UUID) FROM PUBLIC, console_rt, console_platform_force_cmd;
