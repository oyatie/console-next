-- D0.2 eligible second person over the grants made on the 권한 screen: the
-- candidates function reads `access_grants` (role × scope × dates, 0301) next
-- to the legacy system and policy roles, and the grant ledger records how the
-- holder was told of a grant (`channel`). Until now a UI-built tenant had no
-- legacy holder, so every two-person act took the sole-holder path.
-- Head+1 of dev; INTEG renumbers.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. The notice record: who (user_id, the holder), when (occurred_at), how
--    (channel), confirmed by whom (actor_id). The serving role's insert
--    policy stays notice-only (0254). Backfilled notices carry no channel.
-- ---------------------------------------------------------------------------
ALTER TABLE authz_grant_ledger
    ADD COLUMN channel TEXT NULL CHECK (channel IN ('IN_APP')),
    ADD CONSTRAINT authz_grant_ledger_channel_notice CHECK (
        (channel IS NULL OR event = 'NOTICE_DELIVERED')
        AND (source <> 'NOTIFIER' OR channel IS NOT NULL));
COMMENT ON COLUMN authz_grant_ledger.channel IS
    'pd:none — how the grant notice reached its holder (IN_APP: confirmed in the console); NULL for backfilled notices and non-notice rows';

-- ---------------------------------------------------------------------------
-- 2. second_person_candidates gains the access-grant arm. New parameters
--    p_access_domain / p_access_level: the act's (domain, level) tag, NULL for
--    a fenced operation (no access grant can reach it). An access grant is a
--    candidate while ACTIVE, started, not ended, and its role ACTIVE with the
--    line on its current version; Rust confirms each one alone through Cedar
--    (scope_final = false), which also applies the tenant phase. Its age and
--    notice come from the ledger rows 0302 writes (grant_ref = grant id); its
--    definition time is the role's last version (access_roles.updated_at).
--    The demotion guard and the role-edit review flag cover access grants
--    too: a revoke, or an end date moved so the grant has ended.
-- ---------------------------------------------------------------------------
DROP FUNCTION second_person_candidates(UUID, TEXT, TEXT[], TEXT[], UUID, UUID, UUID[],
    TIMESTAMPTZ, INTERVAL, INTERVAL);

CREATE FUNCTION second_person_candidates(
    p_org UUID, p_feature_key TEXT, p_allow_roles TEXT[], p_all_scope_roles TEXT[],
    p_access_domain TEXT, p_access_level TEXT,
    p_branch_id UUID, p_requester UUID, p_excluded UUID[],
    p_case_created_at TIMESTAMPTZ, p_min_grant_age INTERVAL, p_demotion_lookback INTERVAL)
RETURNS TABLE (user_id UUID, via TEXT, grant_ref TEXT, counted BOOLEAN, reason TEXT, scope_final BOOLEAN)
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
WITH win AS (
    SELECT now() - p_min_grant_age AS age_cutoff,
           p_case_created_at - p_demotion_lookback AS demotion_from,
           LEAST(now() - p_min_grant_age, p_case_created_at - p_demotion_lookback) AS requester_from
),
held_sys AS (
    SELECT u.id AS user_id, 'SYSTEM_ROLE'::text AS via, r AS grant_ref,
           NULL::timestamptz AS def_at, NULL::uuid AS def_by, true AS scope_final
    FROM users u CROSS JOIN LATERAL unnest(u.roles) r
    WHERE u.org_id = p_org AND r = ANY (p_allow_roles)
      AND (u.roles && p_all_scope_roles
           OR (p_branch_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM user_branches ub
                WHERE ub.org_id = p_org AND ub.user_id = u.id AND ub.branch_id = p_branch_id)))
),
held_pol AS (
    SELECT a.user_id, 'POLICY_ROLE'::text, pr.id::text,
           GREATEST(prp.created_at, pr.updated_at), pr.updated_by, false
    FROM user_role_assignments a
    JOIN policy_roles pr ON pr.org_id = a.org_id AND pr.id = a.role_id
                        AND pr.status = 'ACTIVE' AND NOT pr.is_system
    JOIN policy_role_permissions prp ON prp.org_id = pr.org_id AND prp.role_id = pr.id
                        AND prp.feature_key = p_feature_key AND prp.permission_level = 'allow'
    WHERE a.org_id = p_org
    FOR SHARE OF a
),
held_acc AS (
    SELECT g.account_id, 'ACCESS_GRANT'::text, g.id::text, ar.updated_at, rv.created_by, false
    FROM access_grants g
    JOIN access_roles ar ON ar.org_id = g.org_id AND ar.id = g.role_id AND ar.status = 'ACTIVE'
    JOIN access_role_versions rv ON rv.org_id = ar.org_id AND rv.role_id = ar.id
                                AND rv.version = ar.version
    JOIN access_role_lines l ON l.org_id = ar.org_id AND l.role_id = ar.id AND l.version = ar.version
                            AND l.domain = p_access_domain AND p_access_level = ANY (l.levels)
    WHERE g.org_id = p_org AND g.status = 'ACTIVE'
      AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now())
    FOR SHARE OF g
),
held AS (SELECT * FROM held_sys UNION ALL SELECT * FROM held_pol UNION ALL SELECT * FROM held_acc),
-- Conflicts with the account mutex (0227/0233 FOR [NO KEY] UPDATE), so a
-- concurrent demotion of a candidate serializes behind this decision.
locked AS (
    SELECT u.id, u.is_active, u.employee_id FROM users u
    WHERE u.org_id = p_org AND u.id IN (SELECT h.user_id FROM held h)
    FOR SHARE OF u
),
meta AS (
    SELECT h.*, l.is_active, l.employee_id, g.occurred_at AS granted_at, g.actor_id AS granted_by,
           acct.occurred_at AS account_at, acct.actor_id AS account_by,
           EXISTS (SELECT 1 FROM authz_grant_ledger n
                   WHERE n.org_id = p_org AND n.user_id = h.user_id AND n.grant_kind = h.via
                     AND n.grant_ref = h.grant_ref AND n.event = 'NOTICE_DELIVERED'
                     AND n.occurred_at >= g.occurred_at) AS notified
    FROM held h JOIN locked l ON l.id = h.user_id
    LEFT JOIN LATERAL (
        SELECT x.occurred_at, x.actor_id FROM authz_grant_ledger x
        WHERE x.org_id = p_org AND x.user_id = h.user_id AND x.grant_kind = h.via
          AND x.grant_ref = h.grant_ref AND x.event = 'GRANTED'
        ORDER BY x.occurred_at DESC LIMIT 1) g ON true
    LEFT JOIN LATERAL (
        SELECT x.occurred_at, x.actor_id FROM authz_grant_ledger x
        WHERE x.org_id = p_org AND x.user_id = h.user_id AND x.grant_kind = 'ACCOUNT'
        ORDER BY x.occurred_at DESC LIMIT 1) acct ON true
),
holders AS (
    SELECT m.user_id, m.via, m.grant_ref, m.scope_final, CASE
        WHEN m.user_id = p_requester OR m.user_id = ANY (COALESCE(p_excluded, '{}')) THEN 'EXCLUDED_PARTY'
        WHEN NOT m.is_active THEN 'INACTIVE'
        WHEN m.employee_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM governed_exceptions ge
            WHERE ge.org_id = p_org AND ge.rule_code = 'NON_EMPLOYEE_ACCOUNT'
              AND ge.subject_type = 'USER_ACCOUNT' AND ge.subject_id = m.user_id
              AND ge.status IN ('APPROVED', 'RECORDED')) THEN 'NO_EMPLOYEE_LINK'
        WHEN m.account_by = p_requester AND m.account_at >= w.requester_from
            THEN 'ACCOUNT_CREATED_BY_REQUESTER'
        WHEN (m.granted_by = p_requester AND m.granted_at >= w.requester_from)
          OR (m.def_by = p_requester AND m.def_at >= w.requester_from) THEN 'GRANTED_BY_REQUESTER'
        WHEN m.granted_at IS NULL OR m.granted_at > w.age_cutoff OR m.def_at > w.age_cutoff
            THEN 'GRANT_TOO_YOUNG'
        WHEN NOT m.notified THEN 'NOTICE_UNDELIVERED'
    END AS reason
    FROM meta m CROSS JOIN win w
),
-- An access grant whose current role version carries the act's line.
acc_line AS (
    SELECT g.id::text AS grant_ref, g.valid_to
    FROM access_grants g
    JOIN access_roles ar ON ar.org_id = g.org_id AND ar.id = g.role_id
    JOIN access_role_lines l ON l.org_id = ar.org_id AND l.role_id = ar.id AND l.version = ar.version
                            AND l.domain = p_access_domain AND p_access_level = ANY (l.levels)
    WHERE g.org_id = p_org
),
-- Demotion guard: qualifying removals since case creation - lookback.
removed AS (
    SELECT x.user_id, x.grant_kind AS via, x.grant_ref, CASE
        WHEN x.user_id = p_requester OR x.user_id = ANY (COALESCE(p_excluded, '{}')) THEN 'EXCLUDED_PARTY'
        WHEN x.actor_id = p_requester AND COALESCE(u.is_active, false) THEN 'DEMOTED_BY_REQUESTER'
        WHEN x.actor_id = p_requester THEN 'REMOVED_THEN_INACTIVE'
        WHEN x.actor_id IS NULL THEN 'REMOVED_BY_UNKNOWN'
        ELSE 'REMOVED_BY_OTHER'
    END AS reason
    FROM authz_grant_ledger x CROSS JOIN win w
    LEFT JOIN users u ON u.org_id = p_org AND u.id = x.user_id
    WHERE x.org_id = p_org AND x.occurred_at >= w.demotion_from
      AND ((x.event = 'REVOKED' AND x.grant_kind = 'SYSTEM_ROLE' AND x.grant_ref = ANY (p_allow_roles))
        OR (x.event = 'REVOKED' AND x.grant_kind = 'POLICY_ROLE' AND EXISTS (
            SELECT 1 FROM policy_role_permissions prp
            WHERE prp.org_id = p_org AND prp.role_id::text = x.grant_ref
              AND prp.feature_key = p_feature_key AND prp.permission_level = 'allow'))
        OR (x.grant_kind = 'ACCESS_GRANT' AND EXISTS (
            SELECT 1 FROM acc_line a WHERE a.grant_ref = x.grant_ref
              AND (x.event = 'REVOKED' OR (x.event = 'REDATED' AND a.valid_to <= now())))))
),
-- ponytail: role-definition edits (retire a role, drop its permission) are
-- not in the ledger, so they are review-flagged, not counted. Add role-level
-- ledger rows if the review queue shows this path being used.
edited AS (
    SELECT NULL::uuid AS user_id, 'POLICY_ROLE'::text AS via, pr.id::text AS grant_ref,
           'ROLE_EDITED_BY_REQUESTER'::text AS reason
    FROM policy_roles pr CROSS JOIN win w
    WHERE pr.org_id = p_org AND pr.updated_by = p_requester AND pr.updated_at >= w.demotion_from
    UNION ALL
    SELECT DISTINCT NULL::uuid, 'ACCESS_ROLE', rv.role_id::text, 'ROLE_EDITED_BY_REQUESTER'
    FROM access_role_versions rv CROSS JOIN win w
    WHERE rv.org_id = p_org AND rv.created_by = p_requester AND rv.created_at >= w.demotion_from
      AND EXISTS (SELECT 1 FROM access_role_lines l
                  WHERE l.org_id = p_org AND l.role_id = rv.role_id AND l.version <= rv.version
                    AND l.domain = p_access_domain AND p_access_level = ANY (l.levels))
)
SELECT user_id, via, grant_ref, reason IS NULL, reason, scope_final FROM holders
UNION ALL
SELECT user_id, via, grant_ref, reason = 'DEMOTED_BY_REQUESTER', reason, true FROM removed
UNION ALL
SELECT user_id, via, grant_ref, false, reason, true FROM edited
$$;
REVOKE ALL ON FUNCTION second_person_candidates(UUID, TEXT, TEXT[], TEXT[], TEXT, TEXT, UUID, UUID,
    UUID[], TIMESTAMPTZ, INTERVAL, INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION second_person_candidates(UUID, TEXT, TEXT[], TEXT[], TEXT, TEXT, UUID, UUID,
    UUID[], TIMESTAMPTZ, INTERVAL, INTERVAL) TO console_rt;
