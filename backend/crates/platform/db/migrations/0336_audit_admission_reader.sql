-- Expand only: isolated command roles read audit metadata, never setting values.
SET LOCAL lock_timeout = '2s';
CREATE FUNCTION audit_admission_snapshot(p_org UUID, p_scopes UUID[])
RETURNS TABLE(phase TEXT, parent_scopes UUID[], versions JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    IF p_org IS DISTINCT FROM NULLIF(current_setting('app.current_org', true), '')::UUID THEN
        RAISE EXCEPTION 'audit tenant does not match transaction' USING ERRCODE = '42501';
    END IF;
    SELECT t.phase INTO phase FROM tenant_phase t WHERE t.org_id=p_org FOR SHARE;
    SELECT COALESCE(array_agg(s.legal_entity_id), '{}'::UUID[]) INTO parent_scopes FROM (
        SELECT w.legal_entity_id FROM workplaces w WHERE w.org_id=p_org AND w.id=ANY(p_scopes)
        UNION SELECT r.legal_entity_id FROM business_registrations r WHERE r.org_id=p_org AND r.id=ANY(p_scopes)
    ) s;
    SELECT COALESCE(jsonb_object_agg(s.name, s.id), '{}'::JSONB) INTO versions FROM (
        SELECT DISTINCT ON (o.key, o.scope_entity_id)
            o.id, o.key || COALESCE('@' || o.scope_entity_id::TEXT, '') AS name
        FROM tenant_setting_overrides o
        WHERE o.org_id=p_org AND o.effective_from<=now()
          AND (o.scope_entity_id IS NULL OR o.scope_entity_id=ANY(p_scopes || parent_scopes))
        ORDER BY o.key, o.scope_entity_id, o.effective_from DESC, o.id DESC
    ) s;
    RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION audit_admission_snapshot(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_admission_snapshot(UUID, UUID[]) TO
    console_app, console_rt, console_leave_definer, console_ontology_writer;
-- Rollback: the old binary ignores this function; remove it after that binary is restored.
