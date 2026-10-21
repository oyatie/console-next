-- UX-R1 PLACEMENT (org-01, move-01, move-02; decisions #18, #21): a person's
-- 사업장 (and so their 법인) follows their 부서. A 부서 has no placement of its
-- own: it sits where its nearest placed ancestor (the 사업장's SITE unit) sits.
--
-- Lane number 0310, renumbered 0319 onto console-react-mvp 4922c5d3 (r33).
--
--   1. placement_unit_workplaces(org, unit): the one resolver unit → 사업장 →
--      법인. The entity crate's `employment_hire::unit_placement` reads it, so
--      registration, binding and 전보 judge a unit the same way.
--   2. placement_mismatches(): live open assignments whose 사업장 is not their
--      employee's 부서's (the detection query). Read-only.
--   3. placement_correct_mismatches(): the one-time repair, run once below.
--      Same-법인 rows only, never deleted: the row is superseded and replaced.
--      When an APPLIED 전보 into that 부서 dated after the row's start exists,
--      the row is split on its date (a 전근 the old binary failed to write);
--      otherwise the whole row moves to the unit's 사업장 (cause MIGRATION: a
--      migration has no actor). One audit row per repair (actor NULL = system).
--      Rows whose 부서 sits in another 법인 are a 전적 question (#30) and are
--      left as they are for a person to decide; placement_mismatches() keeps
--      listing them. Idempotent: a second run finds nothing to repair. A
--      repair stays in the 법인, so its rows keep the old row's employment_id
--      (0313's 법인 stint).
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION placement_unit_workplaces(p_org UUID, p_unit UUID DEFAULT NULL)
RETURNS TABLE (org_unit_id UUID, legal_entity_id UUID, workplace_id UUID)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE heads AS (
        SELECT DISTINCT ON (r.org_unit_id) r.org_unit_id AS id,
               NULLIF(r.attributes ->> 'parent_id', '')::uuid AS parent
        FROM org_unit_revisions r
        WHERE r.org_id = p_org
        ORDER BY r.org_unit_id, r.version DESC
    ), up AS (
        SELECT h.id AS unit, h.id AS at, h.parent, 0 AS depth
        FROM heads h WHERE p_unit IS NULL OR h.id = p_unit
        UNION ALL
        SELECT up.unit, h.id, h.parent, up.depth + 1
        FROM up JOIN heads h ON h.id = up.parent
        WHERE up.depth < 32
    )
    SELECT DISTINCT ON (up.unit) up.unit, p.legal_entity_id, p.workplace_id
    FROM up
    JOIN org_unit_placements p ON p.org_id = p_org AND p.org_unit_id = up.at
     AND p.valid_to IS NULL AND p.workplace_id IS NOT NULL
    ORDER BY up.unit, up.depth
$$;
COMMENT ON FUNCTION placement_unit_workplaces(UUID, UUID) IS
    'The 사업장 and 법인 each org unit sits in today: its own open placement, else its nearest placed ancestor''s (UX-R1 PLACEMENT)';
REVOKE ALL ON FUNCTION placement_unit_workplaces(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION placement_unit_workplaces(UUID, UUID) TO console_rt;

CREATE FUNCTION placement_mismatches()
RETURNS TABLE (org_id UUID, employee_id UUID, assignment_id UUID, legal_entity_id UUID,
               workplace_id UUID, org_unit_id UUID, unit_legal_entity_id UUID, unit_workplace_id UUID)
LANGUAGE sql STABLE AS $$
    SELECT a.org_id, a.employee_id, a.id, a.legal_entity_id, a.workplace_id, e.org_unit_id,
           u.legal_entity_id, u.workplace_id
    FROM employment_assignments a
    JOIN employees e ON e.org_id = a.org_id AND e.id = a.employee_id
    CROSS JOIN LATERAL placement_unit_workplaces(a.org_id, e.org_unit_id) u
    WHERE a.superseded_at IS NULL AND a.valid_to IS NULL AND a.workplace_id IS NOT NULL
      AND e.org_unit_id IS NOT NULL AND u.workplace_id <> a.workplace_id
$$;
COMMENT ON FUNCTION placement_mismatches() IS
    'Live open employment assignments whose 사업장 is not their employee''s 부서''s (UX-R1 PLACEMENT detection; owner only)';
REVOKE ALL ON FUNCTION placement_mismatches() FROM PUBLIC;

CREATE FUNCTION placement_correct_mismatches() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    m       RECORD;
    v_row   RECORD;
    v_event RECORD;
    v_done  INTEGER := 0;
BEGIN
    FOR m IN
        SELECT x.* FROM placement_mismatches() x
        JOIN employment_assignments a ON a.org_id = x.org_id AND a.id = x.assignment_id
        WHERE x.unit_legal_entity_id = x.legal_entity_id AND a.cause <> 'GROUP_TRANSFER'
        ORDER BY x.org_id, x.employee_id
    LOOP
        SELECT * INTO v_row FROM employment_assignments
         WHERE org_id = m.org_id AND id = m.assignment_id FOR UPDATE;
        SELECT ev.id, ev.created_by, entity_try_iso_date(ev.effective_date) AS on_date INTO v_event
          FROM employee_lifecycle_events ev
         WHERE ev.org_id = m.org_id AND ev.employee_id = m.employee_id
           AND ev.event_type = 'TRANSFER' AND ev.state = 'APPLIED'
           AND ev.to_org_unit_id = m.org_unit_id
           AND entity_try_iso_date(ev.effective_date) > v_row.valid_from
         ORDER BY entity_try_iso_date(ev.effective_date) DESC, ev.created_at DESC
         LIMIT 1;
        UPDATE employment_assignments SET superseded_at = now()
         WHERE org_id = m.org_id AND id = m.assignment_id;
        IF v_event.id IS NOT NULL THEN
            -- The 전근 the old binary did not write: the row ends on the 전보's date.
            INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id,
                valid_from, valid_to, cause, group_transfer_id, actor_id, command_id, employment_id)
            VALUES (m.org_id, m.employee_id, v_row.legal_entity_id, v_row.workplace_id,
                v_row.valid_from, v_event.on_date, v_row.cause, v_row.group_transfer_id,
                v_row.actor_id, gen_random_uuid(), v_row.employment_id);
            INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id,
                valid_from, valid_to, cause, actor_id, command_id, employment_id)
            VALUES (m.org_id, m.employee_id, m.unit_legal_entity_id, m.unit_workplace_id,
                v_event.on_date, NULL, 'TRANSFER', v_event.created_by, gen_random_uuid(), v_row.employment_id);
        ELSE
            INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id,
                valid_from, valid_to, cause, command_id, employment_id)
            VALUES (m.org_id, m.employee_id, m.unit_legal_entity_id, m.unit_workplace_id,
                v_row.valid_from, NULL, 'MIGRATION', gen_random_uuid(), v_row.employment_id);
        END IF;
        INSERT INTO audit_events (actor, action, target_type, target_id, before_snap, after_snap,
            trace_id, span_id, occurred_at, org_id)
        VALUES (NULL, 'employment_assignment.placement_corrected', 'employee', m.employee_id::text,
            jsonb_build_object('assignment_id', m.assignment_id, 'legal_entity_id', m.legal_entity_id,
                'workplace_id', m.workplace_id, 'valid_from', v_row.valid_from),
            jsonb_build_object('legal_entity_id', m.unit_legal_entity_id, 'workplace_id', m.unit_workplace_id,
                'org_unit_id', m.org_unit_id, 'valid_from', COALESCE(v_event.on_date, v_row.valid_from),
                'transfer_event_id', v_event.id, 'source', 'migration_placement_follows_unit'),
            replace(gen_random_uuid()::text, '-', ''), left(replace(gen_random_uuid()::text, '-', ''), 16),
            now(), m.org_id);
        v_done := v_done + 1;
    END LOOP;
    RETURN v_done;
END $$;
COMMENT ON FUNCTION placement_correct_mismatches() IS
    'One-time, idempotent, audited repair of same-법인 placement_mismatches() rows (UX-R1 PLACEMENT; owner only)';
REVOKE ALL ON FUNCTION placement_correct_mismatches() FROM PUBLIC;

-- Run once, across tenants (the cross-tenant read needs row security off, the
-- 0259 precedent).
DO $$
DECLARE
    v_fixed INTEGER;
    v_left  INTEGER;
BEGIN
    SET LOCAL row_security = off;
    v_fixed := placement_correct_mismatches();
    SELECT count(*) INTO v_left FROM placement_mismatches();
    RAISE NOTICE 'placement_follows_unit: % assignment(s) corrected, % left for a person (another 법인)', v_fixed, v_left;
END $$;
