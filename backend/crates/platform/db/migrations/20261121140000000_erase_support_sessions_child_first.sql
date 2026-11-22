-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Delete support_session_decisions before support_sessions inside platform_force_remove_direct_org_children so tenant erasure clears the support-session subtree cleanly.
-- contract-of: 20261023100000000
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION platform_force_remove_direct_org_children(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target RECORD;
BEGIN
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
