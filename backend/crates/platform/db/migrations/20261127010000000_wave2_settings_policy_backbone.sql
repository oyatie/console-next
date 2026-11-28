-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Register Wave 2 policy settings, department and person scope chain, and append-only overtime attestations.
-- contract-of: 0136
-- Rollback: retain additive setting definitions and overtime_rule_attestations table; previous binary ignores unused setting keys and table.
SET LOCAL lock_timeout = '2s';

INSERT INTO setting_definitions
    (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)
VALUES
('attendance.overtime_recognition', 'code', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', ARRAY['approval', 'recorded']::TEXT[]),
('attendance.console_clock_out', 'bool', NULL::BIGINT, NULL::BIGINT, 0::BIGINT, 'higher', 'tenant', NULL::TEXT[]),
('hr.fixed_term_limit_months', 'int', 1::BIGINT, 24::BIGINT, 24::BIGINT, 'higher', 'tenant', NULL::TEXT[])
ON CONFLICT (key) DO UPDATE SET
    kind = EXCLUDED.kind, min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value,
    default_ordinal = EXCLUDED.default_ordinal, looser_when = EXCLUDED.looser_when,
    governance = EXCLUDED.governance, codes = EXCLUDED.codes;

CREATE OR REPLACE FUNCTION setting_scope_chain(p_org UUID, p_scope UUID)
RETURNS TABLE(scope_id UUID, layer TEXT, seq INT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_wp   UUID;
    v_le   UUID;
    v_unit UUID;
    v_seq  INT := 0;
    r      RECORD;
BEGIN
    IF p_scope IS NULL THEN
        RETURN;
    END IF;

    -- 1. Workplace
    SELECT w.id, w.legal_entity_id INTO v_wp, v_le
      FROM workplaces w
      JOIN legal_entities e ON e.org_id = w.org_id AND e.id = w.legal_entity_id
     WHERE w.org_id = p_org AND w.id = p_scope
       AND w.voided_at IS NULL AND w.closed_on IS NULL
       AND e.voided_at IS NULL AND e.closed_on IS NULL;
    IF v_wp IS NOT NULL THEN
        RETURN QUERY VALUES (v_wp, 'workplace'::TEXT, 1), (v_le, 'legal_entity'::TEXT, 2);
        RETURN;
    END IF;

    -- 2. Legal entity
    SELECT e.id INTO v_le
      FROM legal_entities e
     WHERE e.org_id = p_org AND e.id = p_scope
       AND e.voided_at IS NULL AND e.closed_on IS NULL;
    IF v_le IS NOT NULL THEN
        RETURN QUERY VALUES (v_le, 'legal_entity'::TEXT, 1);
        RETURN;
    END IF;

    -- 3. Department (org_unit)
    IF EXISTS (
        SELECT 1
          FROM (
              SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes
                FROM org_unit_revisions
               WHERE org_id = p_org AND org_unit_id = p_scope
               ORDER BY org_unit_id, version DESC
          ) h
         WHERE COALESCE(h.attributes->>'status', 'active') <> 'dissolved'
    ) THEN
        FOR r IN
            WITH RECURSIVE heads AS (
                SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes
                  FROM org_unit_revisions
                 WHERE org_id = p_org
                 ORDER BY org_unit_id, version DESC
            ),
            up AS (
                SELECT org_unit_id, attributes, 1 AS depth
                  FROM heads
                 WHERE org_unit_id = p_scope
                UNION ALL
                SELECT h.org_unit_id, h.attributes, u.depth + 1
                  FROM heads h
                  JOIN up u ON h.org_unit_id::text = u.attributes->>'parent_id'
                 WHERE u.depth < 64
                   AND COALESCE(h.attributes->>'status', 'active') <> 'dissolved'
            )
            SELECT up.org_unit_id,
                   p.workplace_id,
                   COALESCE(p.represents_workplace, false) AS represents,
                   w.legal_entity_id
              FROM up
              LEFT JOIN org_unit_placements p
                ON p.org_id = p_org AND p.org_unit_id = up.org_unit_id
               AND p.valid_to IS NULL AND p.workplace_id IS NOT NULL
              LEFT JOIN workplaces w
                ON w.org_id = p_org AND w.id = p.workplace_id
               AND w.voided_at IS NULL AND w.closed_on IS NULL
              LEFT JOIN legal_entities e
                ON e.org_id = p_org AND e.id = w.legal_entity_id
               AND e.voided_at IS NULL AND e.closed_on IS NULL
             ORDER BY up.depth
        LOOP
            IF NOT (r.represents AND r.workplace_id IS NOT NULL) THEN
                v_seq := v_seq + 1;
                scope_id := r.org_unit_id;
                layer := 'department';
                seq := v_seq;
                RETURN NEXT;
            END IF;
            IF r.workplace_id IS NOT NULL AND r.legal_entity_id IS NOT NULL THEN
                v_seq := v_seq + 1;
                scope_id := r.workplace_id;
                layer := 'workplace';
                seq := v_seq;
                RETURN NEXT;
                v_seq := v_seq + 1;
                scope_id := r.legal_entity_id;
                layer := 'legal_entity';
                seq := v_seq;
                RETURN NEXT;
                EXIT;
            END IF;
        END LOOP;
        RETURN;
    END IF;

    -- 4. Person (employee)
    SELECT emp.org_unit_id, ea.workplace_id, ea.legal_entity_id
      INTO v_unit, v_wp, v_le
      FROM employees emp
      LEFT JOIN employment_resolved_assignments ea
        ON ea.org_id = emp.org_id AND ea.employee_id = emp.id
     WHERE emp.org_id = p_org AND emp.id = p_scope
       AND emp.merged_into_employee_id IS NULL
       AND emp.employment_status <> 'VOIDED';
    IF FOUND THEN
        v_seq := 1;
        scope_id := p_scope;
        layer := 'person';
        seq := v_seq;
        RETURN NEXT;
        IF v_unit IS NOT NULL THEN
            FOR r IN SELECT c.scope_id, c.layer FROM setting_scope_chain(p_org, v_unit) c ORDER BY c.seq LOOP
                v_seq := v_seq + 1;
                scope_id := r.scope_id;
                layer := r.layer;
                seq := v_seq;
                RETURN NEXT;
                IF r.layer = 'workplace' THEN
                    v_wp := NULL;
                ELSIF r.layer = 'legal_entity' THEN
                    v_le := NULL;
                END IF;
            END LOOP;
        END IF;
        IF v_wp IS NOT NULL THEN
            IF v_le IS NULL THEN
                SELECT w.legal_entity_id INTO v_le FROM workplaces w WHERE w.org_id = p_org AND w.id = v_wp;
            END IF;
            v_seq := v_seq + 1;
            scope_id := v_wp;
            layer := 'workplace';
            seq := v_seq;
            RETURN NEXT;
        END IF;
        IF v_le IS NOT NULL THEN
            v_seq := v_seq + 1;
            scope_id := v_le;
            layer := 'legal_entity';
            seq := v_seq;
            RETURN NEXT;
        END IF;
        RETURN;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION setting_scope_chain(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION setting_scope_chain(UUID, UUID) TO console_rt;

CREATE OR REPLACE FUNCTION tenant_setting_overrides_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    d            RECORD;
    new_ord      BIGINT;
    cur_value    JSONB;
    cur_ord      BIGINT;
    looser       BOOLEAN;
    chain        UUID[];
    target_layer TEXT;
BEGIN
    SELECT * INTO d FROM setting_definition(NEW.key);
    IF d.kind IS NULL THEN
        RAISE EXCEPTION 'setting_unknown_key' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF d.governance <> 'tenant' THEN
        RAISE EXCEPTION 'setting_not_editable' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    new_ord := setting_ordinal(d.kind, d.codes, NEW.value);
    IF new_ord IS NULL THEN
        RAISE EXCEPTION 'setting_value_invalid' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF d.kind = 'int' AND (new_ord < d.min_value OR new_ord > d.max_value) THEN
        RAISE EXCEPTION 'setting_out_of_range' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF NEW.effective_from < now() THEN
        RAISE EXCEPTION 'setting_backdated' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF NEW.key = 'attendance.overtime_recognition'
       AND NEW.scope_entity_id IS NULL
       AND NEW.value = '"recorded"'::jsonb THEN
        RAISE EXCEPTION 'setting_tenant_root_disallowed' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;

    IF NEW.scope_entity_id IS NOT NULL THEN
        SELECT array_agg(c.scope_id ORDER BY c.seq),
               (array_agg(c.layer ORDER BY c.seq))[1]
          INTO chain, target_layer
          FROM setting_scope_chain(NEW.org_id, NEW.scope_entity_id) c;
        IF chain IS NULL THEN
            RAISE EXCEPTION 'setting_scope_unknown' USING ERRCODE = '23514';
        END IF;
        IF target_layer IN ('department', 'person')
           AND NEW.key NOT LIKE 'attendance.%'
           AND NEW.key <> 'hr.fixed_term_limit_months' THEN
            RAISE EXCEPTION 'setting_scope_not_allowed' USING ERRCODE = '23514', DETAIL = NEW.key;
        END IF;
    END IF;

    SELECT o.value INTO cur_value
      FROM tenant_setting_overrides o
     WHERE o.org_id = NEW.org_id
       AND o.key = NEW.key
       AND o.effective_from <= NEW.effective_from
       AND (o.scope_entity_id IS NULL OR o.scope_entity_id = ANY(chain))
     ORDER BY array_position(chain, o.scope_entity_id) NULLS LAST, o.effective_from DESC
     LIMIT 1;
    cur_ord := COALESCE(setting_ordinal(d.kind, d.codes, cur_value), d.default_ordinal);

    IF target_layer = 'person' AND cur_ord IS NOT NULL THEN
        IF (NEW.key = 'attendance.overtime_recognition' AND new_ord < cur_ord)
           OR (NEW.key = 'hr.fixed_term_limit_months' AND new_ord > cur_ord) THEN
            RAISE EXCEPTION 'setting_person_disfavorable' USING ERRCODE = '23514', DETAIL = NEW.key;
        END IF;
    END IF;

    looser := CASE
        WHEN d.looser_when = 'neutral' THEN false
        WHEN cur_ord IS NULL THEN true
        WHEN d.looser_when = 'higher' THEN new_ord > cur_ord
        ELSE new_ord < cur_ord
    END;
    NEW.direction := CASE
        WHEN looser THEN 'loosen'
        WHEN d.looser_when = 'neutral' OR new_ord = cur_ord THEN 'neutral'
        ELSE 'tighten'
    END;
    NEW.onboarding_exempt := false;
    IF looser AND NEW.effective_from < now() + interval '24 hours' THEN
        IF NOT tenant_setting_onboarding(NEW.org_id) THEN
            RAISE EXCEPTION 'setting_loosening_delay' USING ERRCODE = '23514', DETAIL = NEW.key;
        END IF;
        NEW.onboarding_exempt := true;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TABLE overtime_rule_attestations (
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                   UUID        NOT NULL DEFAULT gen_random_uuid(),
    scope_entity_id      UUID        NULL,
    confirmed_on         DATE        NOT NULL,
    rule_reference       TEXT        NOT NULL CHECK (btrim(rule_reference) <> '' AND char_length(rule_reference) <= 300),
    worker_notice_method TEXT        NOT NULL CHECK (btrim(worker_notice_method) <> '' AND char_length(worker_notice_method) <= 300),
    statutory_basis      TEXT        NOT NULL DEFAULT 'Labor Standards Act Articles 50 and 53'
                             CHECK (btrim(statutory_basis) <> '' AND char_length(statutory_basis) <= 300),
    recorded_by          UUID        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (recorded_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

CREATE INDEX overtime_rule_attestations_scope_idx
    ON overtime_rule_attestations (org_id, scope_entity_id, confirmed_on DESC, created_at DESC);

CREATE FUNCTION overtime_rule_attestations_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('app.platform_force_remove_org', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION
        'overtime_rule_attestations is append-only: % is forbidden (row id=%)',
        TG_OP, OLD.id
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER trg_overtime_rule_attestations_append_only
    BEFORE UPDATE OR DELETE ON overtime_rule_attestations
    FOR EACH ROW EXECUTE FUNCTION overtime_rule_attestations_append_only();

ALTER TABLE overtime_rule_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE overtime_rule_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON overtime_rule_attestations
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::UUID);

REVOKE ALL PRIVILEGES ON overtime_rule_attestations FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON overtime_rule_attestations TO console_rt;
REVOKE ALL ON FUNCTION overtime_rule_attestations_append_only() FROM PUBLIC;

COMMENT ON TABLE overtime_rule_attestations IS 'Append-only confirmations of overtime recognition work rules and worker notification';
COMMENT ON COLUMN overtime_rule_attestations.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN overtime_rule_attestations.id IS 'pd:none — attestation record id';
COMMENT ON COLUMN overtime_rule_attestations.scope_entity_id IS 'pd:none — NULL = tenant-wide; otherwise legal entity, workplace or department';
COMMENT ON COLUMN overtime_rule_attestations.confirmed_on IS 'pd:none — work-rule confirmation date; dates through confirmed_on evaluate as recorded, dates after evaluate as approval';
COMMENT ON COLUMN overtime_rule_attestations.rule_reference IS 'pd:none — work-rules clause citation';
COMMENT ON COLUMN overtime_rule_attestations.worker_notice_method IS 'pd:none — method used to notify workers of the overtime recognition rule';
COMMENT ON COLUMN overtime_rule_attestations.statutory_basis IS 'pd:none — statutory citation behind the overtime recognition rule';
COMMENT ON COLUMN overtime_rule_attestations.recorded_by IS 'pd:personal — account id that recorded the confirmation';
COMMENT ON COLUMN overtime_rule_attestations.created_at IS 'pd:none — insert timestamp';

/* Rollback: restore previous tenant_setting_overrides_check() after rolling the binary back.
DROP TABLE IF EXISTS overtime_rule_attestations;
DROP FUNCTION IF EXISTS overtime_rule_attestations_append_only();
DROP FUNCTION IF EXISTS setting_scope_chain(UUID, UUID);
*/
