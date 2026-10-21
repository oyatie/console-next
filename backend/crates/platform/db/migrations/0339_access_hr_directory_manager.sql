-- UX-R3 SCOPE (AX-5, decisions #15/#19/#26): an HR worker the access model
-- grants 인사기본 등록·수정 registers people. The register door decides the
-- place over the caller's grant set (Cedar, in the app); this command-boundary
-- predicate — the second net every registration and its first home-branch
-- routing run — admitted only the legacy SUPER_ADMIN/EXECUTIVE roles, so a
-- granted HR worker's registration was refused (or, past the app check,
-- orphaned). It now also admits an account holding a grant that counts now
-- (ACTIVE, inside its dates, role ACTIVE, the tenant OPERATING or the grant
-- marked 설정 단계부터) whose role's current version carries hr_basic edit.
--
-- Expand-only: the function keeps its signature; the legacy branches are
-- byte-identical. Lane number (SCOPE range 0330-0334); INTEG renumbers.
SET LOCAL lock_timeout = '2s';

GRANT SELECT ON access_grants, access_roles, access_role_lines, tenant_phase
    TO console_leave_definer;

CREATE OR REPLACE FUNCTION leave_api.assert_employee_directory_manager(
    p_org_id UUID, p_actor UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.users u
        WHERE u.id = p_actor
          AND u.org_id = p_org_id
          AND u.is_active
          AND (
              u.roles @> ARRAY['SUPER_ADMIN']::TEXT[]
              OR (
                  -- A custom grant can only be org-wide when the actor has
                  -- the resolver's live All scope (EXECUTIVE/SUPER_ADMIN).
                  (u.roles @> ARRAY['SUPER_ADMIN']::TEXT[]
                   OR u.roles @> ARRAY['EXECUTIVE']::TEXT[])
                  AND EXISTS (
                      SELECT 1
                      FROM public.user_role_assignments ura
                      JOIN public.policy_roles pr
                        ON pr.org_id = ura.org_id AND pr.id = ura.role_id
                      JOIN public.policy_role_permissions prp
                        ON prp.org_id = pr.org_id AND prp.role_id = pr.id
                      WHERE ura.org_id = p_org_id
                        AND ura.user_id = p_actor
                        AND pr.status = 'ACTIVE'
                        AND NOT pr.is_system
                        AND prp.feature_key = 'employee_directory_manage'
                        AND prp.permission_level = 'allow'
                        AND NOT EXISTS (
                            SELECT 1
                            FROM public.policy_role_conditions prc
                            WHERE prc.org_id = pr.org_id
                              AND prc.role_id = pr.id
                              AND (
                                  prc.operator NOT IN ('equals', 'in')
                                  OR prc.attribute = 'branch'
                                  OR prc.attribute <> 'team'
                                  OR u.team IS NULL
                                  OR NOT EXISTS (
                                      SELECT 1
                                      FROM pg_catalog.unnest(prc.condition_values) value
                                      WHERE pg_catalog.btrim(value) = u.team
                                         OR pg_catalog.upper(pg_catalog.btrim(value)) = CASE u.team
                                              WHEN '정비' THEN 'MAINTENANCE'
                                              WHEN '예방' THEN 'PREVENTION'
                                              WHEN '관리' THEN 'MANAGEMENT'
                                              WHEN '접수' THEN 'RECEPTION'
                                              ELSE NULL
                                            END
                                  )
                              )
                        )
                  )
              )
              -- AX-5: a pilot access grant that counts now, with hr_basic edit.
              OR EXISTS (
                  SELECT 1
                  FROM public.access_grants g
                  JOIN public.access_roles r
                    ON r.org_id = g.org_id AND r.id = g.role_id AND r.status = 'ACTIVE'
                  JOIN public.access_role_lines l
                    ON l.org_id = r.org_id AND l.role_id = r.id AND l.version = r.version
                  WHERE g.org_id = p_org_id
                    AND g.account_id = p_actor
                    AND g.status = 'ACTIVE'
                    AND g.include_descendants
                    AND l.domain = 'hr_basic'
                    AND l.levels @> ARRAY['edit']::TEXT[]
                    AND g.valid_from <= pg_catalog.now()
                    AND (g.valid_to IS NULL OR pg_catalog.now() < g.valid_to)
                    AND (g.effective_in_setup OR COALESCE(
                        (SELECT p.phase FROM public.tenant_phase p WHERE p.org_id = p_org_id),
                        'OPERATING') = 'OPERATING')
              )
          )
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'employee_create.actor_forbidden';
    END IF;
END;
$$;
ALTER FUNCTION leave_api.assert_employee_directory_manager(UUID, UUID) OWNER TO console_leave_definer;
REVOKE ALL ON FUNCTION leave_api.assert_employee_directory_manager(UUID, UUID)
    FROM PUBLIC, console_rt, console_leave_cmd;
