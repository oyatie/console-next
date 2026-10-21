-- CRUD (owner live test 2026-10-07: 「부서, 팀, 인원 … only able to add them」;
-- decisions #21 full CRUD, design-language §6.4 「delete means close, dissolve
-- or void wherever retention applies」). Numbered head+1 of console-react-mvp
-- 99dafebc (migrations end at 0304); INTEG renumbers.
--
-- A 부서 created by mistake and never used is DELETED outright, in either
-- phase; a used one is 폐지 (a dissolved revision, history kept). "Never used"
-- is decided by the writer (entity adapter `org_erase.rs`, typed refusals) and
-- backstopped here by the RESTRICT keys every use leaves: employees.org_unit_id,
-- access_grants, change_sets, job_positions (and the re-check below).
--
-- 1. feature_catalog: `org_unit_manage`, the Cedar-only action behind the
--    direct 부서 writes (erase; 폐지, 부서장 and 부서 코드 after go-live).
-- 2. The canonical org-structure immutability trigger (0215) admits DELETE on
--    org_unit_revisions, and the placement guard (0259) admits DELETE on a
--    부서's own placements, only while `org_unit_erase()` runs
--    (app.org_unit_erase = 'on', set and cleared inside it; the runtime role
--    holds no DELETE on either table, so it cannot set the flag usefully).
-- 3. org_unit_erase(units): SECURITY DEFINER, the tenant armed; refuses a
--    unit that is a 사업장's own unit, still has a child outside the set, or
--    was ever named as another unit's parent outside the set; then removes
--    order rows, placements, source bindings, revisions and the anchor.
SET LOCAL lock_timeout = '2s';

-- 1.
INSERT INTO feature_catalog (feature_key) VALUES ('org_unit_manage')
ON CONFLICT (feature_key) DO NOTHING;

-- 2.
CREATE OR REPLACE FUNCTION canonical_org_structure_row_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'org_unit_revisions' AND TG_OP = 'DELETE'
       AND current_setting('app.org_unit_erase', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'canonical org-structure table %: % is refused, the row is immutable',
        TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE OR REPLACE FUNCTION org_unit_placements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_setting('app.platform_force_remove_org', true) = 'on' THEN
            RETURN OLD;
        END IF;
        IF current_setting('app.org_unit_erase', true) = 'on' AND NOT OLD.represents_workplace THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'org_unit_placements is append-only';
    END IF;
    IF (NEW.org_id, NEW.id, NEW.org_unit_id, NEW.legal_entity_id, NEW.workplace_id,
        NEW.represents_workplace, NEW.valid_from, NEW.change_mode, NEW.actor_id, NEW.command_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.org_id, OLD.id, OLD.org_unit_id, OLD.legal_entity_id, OLD.workplace_id,
        OLD.represents_workplace, OLD.valid_from, OLD.change_mode, OLD.actor_id, OLD.command_id, OLD.created_at)
       OR (OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to) THEN
        RAISE EXCEPTION 'org_unit_placements rows only close once (id=%)', OLD.id;
    END IF;
    RETURN NEW;
END $$;

-- 3.
CREATE FUNCTION org_unit_erase(p_units UUID[])
RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org UUID := NULLIF(current_setting('app.current_org', true), '')::uuid;
BEGIN
    IF v_org IS NULL THEN
        RAISE EXCEPTION 'org unit erase needs an armed tenant';
    END IF;
    IF EXISTS (SELECT 1 FROM org_unit_placements p
                WHERE p.org_id = v_org AND p.org_unit_id = ANY(p_units) AND p.represents_workplace) THEN
        RAISE EXCEPTION 'org unit erase refused: a 사업장''s own unit is closed with the 사업장';
    END IF;
    IF EXISTS (SELECT 1 FROM org_unit_revisions r
                WHERE r.org_id = v_org AND NOT (r.org_unit_id = ANY(p_units))
                  AND (r.attributes->>'parent_id') = ANY(SELECT u::text FROM unnest(p_units) u)) THEN
        RAISE EXCEPTION 'org unit erase refused: another unit names one of these as its parent';
    END IF;
    PERFORM set_config('app.org_unit_erase', 'on', true);
    DELETE FROM org_unit_positions WHERE org_id = v_org AND org_unit_id = ANY(p_units);
    DELETE FROM org_unit_placements WHERE org_id = v_org AND org_unit_id = ANY(p_units);
    DELETE FROM org_unit_source_bindings WHERE org_id = v_org AND org_unit_id = ANY(p_units);
    DELETE FROM org_unit_revisions WHERE org_id = v_org AND org_unit_id = ANY(p_units);
    DELETE FROM org_units WHERE org_id = v_org AND id = ANY(p_units);
    PERFORM set_config('app.org_unit_erase', 'off', true);
END $$;
REVOKE ALL ON FUNCTION org_unit_erase(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_unit_erase(UUID[]) TO console_rt;
