-- LC-B1: one employment = one 법인 stint (inter-entity-transfer.md §4.2, §4.3
-- M0-M2; lifecycle-events-work-items.md LC-B1). EXPAND ONLY: every new column
-- is nullable, no reader or writer changes (LC-B2 moves the binding readers and
-- dual-writes).
-- One difference for the previous release: the redefined update guard refuses
-- re-setting a non-null employment_heads.valid_to (rule 4), which the old guard
-- allowed; setting it from NULL on EXITED still passes. Numbered head+1 after BE-MIG's 0305; INTEG renumbers.
--
--   1. employment_heads gains the period columns, a per-employee no-overlap
--      trigger and a redefined update guard (IT §4.2 rules 1-4).
--   2. employment_id (nullable) on the employment-scoped tables.
--   3. employment_backfill_findings: the 이관 확인 queue's rows (M3 surfaces
--      them; nothing is guessed).
--   4. employment_backfill_plan() (M0, read-only) and employment_backfill()
--      (M2, idempotent), run once below for every tenant.
--
-- `employees` is never written here (acceptance: byte-identical before and
-- after). Event order is (effective_date, applied_at|created_at, id):
-- employee_lifecycle_events has no `seq` (0279 added seq to
-- object_lifecycle_transitions, not to this table).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. employment_heads: the period columns.
-- FKs that a tenant force-remove would trip are SET NULL / CASCADE: the
-- removal sweep (platform_force_remove_direct_org_children) never visits
-- employment_heads (its org FK is CASCADE) and deletes legal_entities and
-- employees before the organization cascade reaches the heads.
ALTER TABLE employment_heads
    ADD COLUMN employee_id               UUID    NULL,
    ADD COLUMN legal_entity_id           UUID    NULL,
    ADD COLUMN hire_date                 DATE    NULL,
    ADD COLUMN exit_date                 DATE    NULL,
    ADD COLUMN exit_reason_code          TEXT    NULL
        CONSTRAINT employment_heads_exit_reason_code_shape
        CHECK (exit_reason_code IS NULL OR char_length(btrim(exit_reason_code)) BETWEEN 1 AND 100),
    ADD COLUMN service_start_date        DATE    NULL,
    ADD COLUMN severance_start_date      DATE    NULL,
    ADD COLUMN continuity                TEXT    NULL
        CONSTRAINT employment_heads_continuity_check
        CHECK (continuity IN ('NEW', 'SETTLED', 'CARRIED', 'REHIRE')),
    ADD COLUMN continuity_dimensions     JSONB   NULL
        CONSTRAINT employment_heads_continuity_dimensions_object
        CHECK (continuity_dimensions IS NULL OR jsonb_typeof(continuity_dimensions) = 'object'),
    ADD COLUMN predecessor_employment_id UUID    NULL,
    ADD COLUMN cause                     TEXT    NULL
        CONSTRAINT employment_heads_cause_check
        CHECK (cause IN ('HIRE', 'REHIRE', 'GROUP_TRANSFER', 'MIGRATION')),
    ADD COLUMN needs_confirmation        BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT employment_heads_employee_fk FOREIGN KEY (employee_id, org_id)
        REFERENCES employees (id, org_id) ON DELETE CASCADE,
    ADD CONSTRAINT employment_heads_legal_entity_fk FOREIGN KEY (org_id, legal_entity_id)
        REFERENCES legal_entities (org_id, id) ON DELETE SET NULL (legal_entity_id),
    ADD CONSTRAINT employment_heads_predecessor_fk FOREIGN KEY (org_id, predecessor_employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (predecessor_employment_id),
    ADD CONSTRAINT employment_heads_predecessor_not_self CHECK (predecessor_employment_id <> id),
    ADD CONSTRAINT employment_heads_period_has_employee CHECK (hire_date IS NULL OR employee_id IS NOT NULL),
    ADD CONSTRAINT employment_heads_exit_needs_hire CHECK (exit_date IS NULL OR hire_date IS NOT NULL),
    ADD CONSTRAINT employment_heads_exit_after_hire CHECK (exit_date IS NULL OR exit_date >= hire_date),
    -- exit_date is the 마지막 근무일 (#9) and valid_to is exclusive: KST midnight after it.
    ADD CONSTRAINT employment_heads_closed_window
        CHECK (exit_date IS NULL OR valid_to = ((exit_date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')),
    ADD CONSTRAINT employment_heads_service_start CHECK (service_start_date IS NULL OR service_start_date <= hire_date),
    ADD CONSTRAINT employment_heads_cause_shape CHECK (
        (cause IS NULL) = (continuity IS NULL)
        AND (cause IS DISTINCT FROM 'REHIRE' OR continuity = 'REHIRE')
        AND (cause IS DISTINCT FROM 'GROUP_TRANSFER' OR continuity IN ('SETTLED', 'CARRIED'))
        AND (cause NOT IN ('HIRE', 'MIGRATION') OR continuity = 'NEW'));

CREATE INDEX employment_heads_employee_idx ON employment_heads (org_id, employee_id, hire_date)
    WHERE employee_id IS NOT NULL;

COMMENT ON COLUMN employment_heads.employee_id IS 'pd:personal — 직원 레코드 식별자 - employees.id (이 고용관계의 사람)';
COMMENT ON COLUMN employment_heads.legal_entity_id IS 'pd:personal — 특정 자연인의 고용 법인; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employment_heads.hire_date IS 'pd:personal — 이 법인에서의 입사일';
COMMENT ON COLUMN employment_heads.exit_date IS 'pd:personal — 이 법인에서의 마지막 근무일(퇴직일, #9)';
COMMENT ON COLUMN employment_heads.exit_reason_code IS 'pd:personal — 퇴직 사유 코드(영 §20 8호)';
COMMENT ON COLUMN employment_heads.service_start_date IS 'pd:personal — 근속 기산일';
COMMENT ON COLUMN employment_heads.severance_start_date IS 'pd:personal — 퇴직금 기산일(중간정산·승계에 따라 근속 기산일과 다를 수 있음)';
COMMENT ON COLUMN employment_heads.continuity IS 'pd:personal — 이전 고용과의 연속 형태(NEW/SETTLED/CARRIED/REHIRE)';
COMMENT ON COLUMN employment_heads.continuity_dimensions IS 'pd:personal — 차원별 승계(퇴직금/연차/근속), 전적 T2';
COMMENT ON COLUMN employment_heads.predecessor_employment_id IS 'pd:personal — 직전 고용관계 식별자';
COMMENT ON COLUMN employment_heads.cause IS 'pd:personal — 고용관계가 열린 원인(HIRE/REHIRE/GROUP_TRANSFER/MIGRATION)';
COMMENT ON COLUMN employment_heads.needs_confirmation IS 'pd:personal — 이관 값이 확인 전이라 정정 가능함';

-- No two employments of one person overlap (by date: [hire_date, exit_date]).
-- btree_gist is not installed, so a trigger, as employment_assignments does;
-- the advisory lock serialises two writers of one employee.
CREATE FUNCTION employment_heads_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.employee_id IS NULL OR NEW.hire_date IS NULL OR NEW.exit_date < NEW.hire_date THEN
        RETURN NEW;   -- not a period (yet); employment_heads_exit_after_hire refuses the inverted one
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('employment_heads:' || NEW.employee_id::text, 0));
    IF EXISTS (
        SELECT 1 FROM employment_heads h
        WHERE h.org_id = NEW.org_id AND h.employee_id = NEW.employee_id AND h.id <> NEW.id
          AND h.hire_date IS NOT NULL
          AND daterange(h.hire_date, h.exit_date, '[]') && daterange(NEW.hire_date, NEW.exit_date, '[]')
    ) THEN
        RAISE EXCEPTION 'employment_overlap: employee % already has an employment in that period', NEW.employee_id
            USING ERRCODE = '23P01';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_employment_heads_no_overlap
    BEFORE INSERT OR UPDATE ON employment_heads
    FOR EACH ROW EXECUTE FUNCTION employment_heads_no_overlap();

-- The 0214 guard let only valid_to move, so neither this backfill nor a
-- reversal could run under it. Redefined (IT §4.2):
--   1. a period column moves NULL -> value once;
--   2. while needs_confirmation, hire_date, legal_entity_id, service_start_date
--      and severance_start_date may be corrected; true -> false freezes them
--      (false -> true only before the period is filled);
--   3. the close facts (valid_to, exit_date, exit_reason_code) are set once.
--      When exit_date is first set, valid_to is aligned to exit_date + 1 in the
--      same statement (CHECK employment_heads_closed_window). They return to
--      NULL together only when app.employment_reopen names a consumed
--      EXIT_REVERSAL governed exception of the same tenant (#4);
--   4. every other change raises. Stated over the row (jsonb keys), so a column
--      a later migration adds falls under rule 4 until its rule is written.
DROP TRIGGER trg_employment_heads_only_valid_to_moves ON employment_heads;
-- employment_head_only_valid_to_moves() stays for the N-1 release (blue/green
-- share this schema during a rollout); a later migration marked
-- `-- contract-of: 0313` drops it.

CREATE FUNCTION employment_heads_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_old  JSONB := to_jsonb(OLD);
    v_new  JSONB := to_jsonb(NEW);
    v_key  TEXT;
    v_flag TEXT;
BEGIN
    FOR v_key IN
        SELECT n.key FROM jsonb_each(v_new) n WHERE n.value IS DISTINCT FROM v_old -> n.key
    LOOP
        IF v_key IN ('valid_to', 'exit_date', 'exit_reason_code') THEN
            IF v_old ->> v_key IS NULL THEN
                CONTINUE;                                   -- rule 3: set once
            ELSIF v_key = 'valid_to' AND OLD.exit_date IS NULL AND NEW.exit_date IS NOT NULL THEN
                CONTINUE;                                   -- rule 3: aligned with the first exit_date
            ELSIF NEW.valid_to IS NULL AND NEW.exit_date IS NULL AND NEW.exit_reason_code IS NULL THEN
                v_flag := current_setting('app.employment_reopen', true);
                IF v_flag ~ '^[0-9a-fA-F-]{36}$' AND EXISTS (
                    SELECT 1 FROM governed_exceptions g
                    WHERE g.id = v_flag::uuid AND g.org_id = NEW.org_id
                      AND g.rule_code = 'EXIT_REVERSAL' AND g.consumed_at IS NOT NULL
                ) THEN
                    CONTINUE;                               -- rule 3: governed reopen
                END IF;
                RAISE EXCEPTION 'employment_head_reopen_refused: reopening employment % needs a consumed EXIT_REVERSAL exception', OLD.id
                    USING ERRCODE = '55000';
            END IF;
        ELSIF v_key IN ('employee_id', 'legal_entity_id', 'hire_date', 'service_start_date',
                        'severance_start_date', 'continuity', 'continuity_dimensions',
                        'predecessor_employment_id', 'cause') THEN
            IF v_old ->> v_key IS NULL THEN
                CONTINUE;                                   -- rule 1
            ELSIF OLD.needs_confirmation
                  AND v_key IN ('hire_date', 'legal_entity_id', 'service_start_date', 'severance_start_date')
                  AND v_new ->> v_key IS NOT NULL THEN
                CONTINUE;                                   -- rule 2
            END IF;
        ELSIF v_key = 'needs_confirmation' THEN
            IF NOT NEW.needs_confirmation OR OLD.hire_date IS NULL THEN
                CONTINUE;                                   -- rule 2
            END IF;
        END IF;
        RAISE EXCEPTION 'employment_head_immutable: employment_heads.% cannot change on %', v_key, OLD.id
            USING ERRCODE = '55000';                        -- rule 4
    END LOOP;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_employment_heads_guard
    BEFORE UPDATE ON employment_heads
    FOR EACH ROW EXECUTE FUNCTION employment_heads_guard();

-- ---------------------------------------------------------------------------
-- 2. employment_id on the employment-scoped tables (nullable; LC-B2 writes it
-- on insert). SET NULL keeps the row when a head is erased with its person.
ALTER TABLE employment_assignments ADD COLUMN employment_id UUID NULL,
    ADD CONSTRAINT employment_assignments_employment_fk FOREIGN KEY (org_id, employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id);
ALTER TABLE employee_contracts ADD COLUMN employment_id UUID NULL,
    ADD CONSTRAINT employee_contracts_employment_fk FOREIGN KEY (org_id, employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id);
ALTER TABLE employee_contract_wages ADD COLUMN employment_id UUID NULL,
    ADD CONSTRAINT employee_contract_wages_employment_fk FOREIGN KEY (org_id, employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id);
ALTER TABLE employee_employment_profiles ADD COLUMN employment_id UUID NULL,
    ADD CONSTRAINT employee_employment_profiles_employment_fk FOREIGN KEY (org_id, employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id);
ALTER TABLE employee_exit_cases ADD COLUMN employment_id UUID NULL,
    ADD CONSTRAINT employee_exit_cases_employment_fk FOREIGN KEY (org_id, employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id);
ALTER TABLE employee_lifecycle_events ADD COLUMN employment_id UUID NULL,
    ADD CONSTRAINT employee_lifecycle_events_employment_fk FOREIGN KEY (org_id, employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id);
ALTER TABLE employee_register_facts ADD COLUMN employment_id UUID NULL,
    ADD CONSTRAINT employee_register_facts_employment_fk FOREIGN KEY (org_id, employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id);
ALTER TABLE annual_leave_obligations ADD COLUMN employment_id UUID NULL,
    ADD CONSTRAINT annual_leave_obligations_employment_fk FOREIGN KEY (org_id, employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id);
-- The PK (org_id, employee_id) stays until LC-B2: a key column cannot be NULL
-- in the expand phase, and nothing writes this table yet (the live 연차
-- balance is still employees.leave_*, see leave_api.import_employee_leave_balance).
ALTER TABLE employee_leave_balances ADD COLUMN employment_id UUID NULL,
    ADD CONSTRAINT employee_leave_balances_employment_fk FOREIGN KEY (org_id, employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id);
ALTER TABLE employee_group_transfers
    ADD COLUMN from_employment_id UUID NULL,
    ADD COLUMN to_employment_id UUID NULL,
    ADD CONSTRAINT employee_group_transfers_from_employment_fk FOREIGN KEY (org_id, from_employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (from_employment_id),
    ADD CONSTRAINT employee_group_transfers_to_employment_fk FOREIGN KEY (org_id, to_employment_id)
        REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (to_employment_id);

COMMENT ON COLUMN employment_assignments.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN employee_contracts.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN employee_contract_wages.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN employee_employment_profiles.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN employee_exit_cases.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN employee_lifecycle_events.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN employee_register_facts.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN annual_leave_obligations.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN employee_leave_balances.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN employee_group_transfers.from_employment_id IS 'pd:personal — 전적으로 닫힌 고용관계 - employment_heads.id';
COMMENT ON COLUMN employee_group_transfers.to_employment_id IS 'pd:personal — 전적으로 열린 고용관계 - employment_heads.id';

-- The append-only ledgers admit exactly one more UPDATE: employment_id filled
-- NULL -> value with nothing else changing (this backfill, later LC-B2's).
CREATE FUNCTION only_employment_id_filled(p_old JSONB, p_new JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_old ->> 'employment_id' IS NULL AND p_new ->> 'employment_id' IS NOT NULL
       AND (p_new - 'employment_id') = (p_old - 'employment_id')
$$;

CREATE OR REPLACE FUNCTION employee_contracts_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND only_employment_id_filled(to_jsonb(OLD), to_jsonb(NEW)) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'employee_contracts is append-only: % is forbidden (a correction is a superseding row)', TG_OP
        USING ERRCODE = '55000';
END $$;

CREATE OR REPLACE FUNCTION employee_contract_wages_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND only_employment_id_filled(to_jsonb(OLD), to_jsonb(NEW)) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'employee_contract_wages is append-only: % is forbidden (a raise is a new effective-dated row)', TG_OP
        USING ERRCODE = '55000';
END $$;

CREATE OR REPLACE FUNCTION employee_lifecycle_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('app.platform_force_remove_org', true) = 'on' THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.state = 'SCHEDULED'
       AND NEW.id = OLD.id
       AND NEW.org_id = OLD.org_id
       AND NEW.employee_id = OLD.employee_id
       AND NEW.event_type = OLD.event_type
       AND NEW.effective_date = OLD.effective_date
       AND NEW.created_by = OLD.created_by
       AND NEW.created_at = OLD.created_at THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND only_employment_id_filled(to_jsonb(OLD), to_jsonb(NEW)) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'employee_lifecycle_events is append-only: % is forbidden (row id=%)',
        TG_OP, OLD.id
        USING ERRCODE = '55000';
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. employment_backfill_findings: the anomalies the backfill would not guess
-- (IT §4.3 M2/M3). Immutable but for its resolution, set once by M3.
CREATE TABLE employment_backfill_findings (
    org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id            UUID        NOT NULL DEFAULT gen_random_uuid(),
    employee_id   UUID        NOT NULL,
    employment_id UUID        NULL,
    kind          TEXT        NOT NULL CHECK (kind IN (
                      'EXITED_WITHOUT_TERMINATE', 'EXITED_WITHOUT_EXIT_DATE', 'ACTIVE_AFTER_CLOSE',
                      'CLOSE_WITHOUT_OPEN_EMPLOYMENT', 'REVERSAL_WITHOUT_CLOSE',
                      'REHIRE_WITHOUT_PRIOR_CLOSE', 'GROUP_TRANSFER_WITHOUT_OPEN_EMPLOYMENT',
                      'GROUP_TRANSFER_FACTS_MISSING', 'ENTITY_CHANGED_WITHOUT_GROUP_TRANSFER',
                      'HIRE_DATE_AFTER_FIRST_EVENT', 'HIRE_DATE_UNKNOWN', 'EVENT_DATE_UNREADABLE',
                      'EXIT_BEFORE_HIRE', 'PERIOD_OVERLAP', 'LEGAL_ENTITY_UNKNOWN',
                      'BOUND_HEAD_UNMATCHED', 'ASSIGNMENT_OUTSIDE_EMPLOYMENT')),
    detail        JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
    -- md5(kind || detail): a rerun that finds the same thing adds nothing.
    fingerprint   TEXT        NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{32}$'),
    found_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ NULL,
    resolved_by   UUID        NULL,
    resolution    TEXT        NULL CHECK (resolution IN ('SAME_ENTITY_CORRECTED', 'GROUP_TRANSFER_RECORDED', 'CONFIRMED')),
    PRIMARY KEY (org_id, id),
    UNIQUE (org_id, employee_id, fingerprint),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, employment_id) REFERENCES employment_heads (org_id, id) ON DELETE SET NULL (employment_id),
    FOREIGN KEY (resolved_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT employment_backfill_findings_resolution_shape
        CHECK ((resolved_at IS NULL) = (resolved_by IS NULL) AND (resolved_at IS NULL) = (resolution IS NULL))
);
CREATE INDEX employment_backfill_findings_open_idx
    ON employment_backfill_findings (org_id, found_at) WHERE resolved_at IS NULL;

CREATE FUNCTION employment_backfill_findings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF current_setting('app.platform_force_remove_org', true) = 'on' THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'employment_backfill_findings is append-only: DELETE is forbidden'
            USING ERRCODE = '55000';
    END IF;
    IF OLD.resolved_at IS NOT NULL
       OR (to_jsonb(NEW) - ARRAY['resolved_at', 'resolved_by', 'resolution'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['resolved_at', 'resolved_by', 'resolution']) THEN
        RAISE EXCEPTION 'employment_backfill_findings: only an open finding''s resolution may be recorded (id=%)', OLD.id
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_employment_backfill_findings_guard
    BEFORE UPDATE OR DELETE ON employment_backfill_findings
    FOR EACH ROW EXECUTE FUNCTION employment_backfill_findings_guard();

ALTER TABLE employment_backfill_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_backfill_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employment_backfill_findings
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON employment_backfill_findings FROM PUBLIC;
REVOKE ALL ON employment_backfill_findings FROM console_rt;
GRANT SELECT, UPDATE ON employment_backfill_findings TO console_rt;

COMMENT ON TABLE employment_backfill_findings IS '고용관계 이관(LC-B1) 중 추정하지 않은 이상 항목 — 이관 확인 대기열(M3)의 원천';
COMMENT ON COLUMN employment_backfill_findings.org_id IS 'pd:personal — 특정 자연인의 고용 이관 항목; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN employment_backfill_findings.id IS 'pd:personal — 이관 확인 항목 식별자';
COMMENT ON COLUMN employment_backfill_findings.employee_id IS 'pd:personal — 직원 레코드 식별자 - employees.id';
COMMENT ON COLUMN employment_backfill_findings.employment_id IS 'pd:personal — 고용관계 식별자 - employment_heads.id';
COMMENT ON COLUMN employment_backfill_findings.kind IS 'pd:personal — 이상 유형 코드';
COMMENT ON COLUMN employment_backfill_findings.detail IS 'pd:personal,undeclared — 이상의 근거(날짜·이벤트 id·법인 id)';
COMMENT ON COLUMN employment_backfill_findings.fingerprint IS 'pd:personal — 같은 이상의 재기록을 막는 다이제스트';
COMMENT ON COLUMN employment_backfill_findings.found_at IS 'pd:personal — 발견 시각';
COMMENT ON COLUMN employment_backfill_findings.resolved_at IS 'pd:personal — 확인 처리 시각';
COMMENT ON COLUMN employment_backfill_findings.resolved_by IS 'pd:personal — 처리자 식별자 - users.id';
COMMENT ON COLUMN employment_backfill_findings.resolution IS 'pd:personal — 확인 처리 방식';

-- ---------------------------------------------------------------------------
-- 4a. employment_backfill_plan(org): M0, read-only. Replays each person's
-- effective lifecycle events into employment periods and reports what it
-- would not guess. One row per period (finding_kind NULL) or per finding.
--
-- Effective = APPLIED, not RESCIND, not voided by an APPLIED row. TERMINATE /
-- OFFBOARD close (exit_date = the event date); EXIT_REVERSAL reopens the
-- period the last close closed; REHIRE opens a period (its hire date is the
-- following ONBOARD's when one comes, as a PRE_HIRE rehire records today's
-- REHIRE and a scheduled ONBOARD); GROUP_TRANSFER closes on start - 1 and
-- opens on start with the 0278 facts. The current period's hire date is
-- employees.hire_on (the 정정-corrected truth); period 1 of a rehired person
-- comes from ONBOARD, the bound head, or the first assignment.
CREATE FUNCTION employment_backfill_plan(p_org UUID)
RETURNS TABLE (
    employee_id           UUID,
    period_no             INT,
    hire_date             DATE,
    exit_date             DATE,
    exit_reason_code      TEXT,
    legal_entity_id       UUID,
    cause                 TEXT,
    continuity            TEXT,
    continuity_dimensions JSONB,
    service_start_date    DATE,
    needs_confirmation    BOOLEAN,
    finding_kind          TEXT,
    finding_detail        JSONB
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    e           RECORD;
    ev          RECORD;
    gt          RECORD;
    v_rehires   INT;
    v_first_rh  DATE;
    v_open      BOOLEAN;
    v_closed_by UUID;
    v_onboarded BOOLEAN;
    v_first_ev  DATE;
    v_prev_ent  UUID;
    v_gt_ent    UUID;
    a           RECORD;
BEGIN
    FOR e IN
        SELECT x.id, x.hire_on, x.exit_on, x.employment_status, x.source_filename,
               (x.created_at AT TIME ZONE 'Asia/Seoul')::date AS created_on,
               (SELECT (h.valid_from AT TIME ZONE 'Asia/Seoul')::date
                FROM employment_source_bindings b JOIN employment_heads h
                  ON h.org_id = b.org_id AND h.id = b.employment_id
                WHERE b.org_id = x.org_id AND b.employee_id = x.id) AS bound_from
        FROM employees x
        WHERE x.org_id = p_org AND x.employment_status <> 'VOIDED' AND x.merged_into_employee_id IS NULL
        ORDER BY x.id
    LOOP
        employee_id := e.id;
        SELECT count(*), min(entity_try_iso_date(l.effective_date)) INTO v_rehires, v_first_rh
        FROM employee_lifecycle_events l
        WHERE l.org_id = p_org AND l.employee_id = e.id AND l.state = 'APPLIED' AND l.event_type = 'REHIRE'
          AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v
                          WHERE v.org_id = l.org_id AND v.voids_event_id = l.id AND v.state = 'APPLIED');

        -- Period 1.
        period_no := 1; exit_date := NULL; exit_reason_code := NULL; needs_confirmation := false;
        cause := CASE WHEN e.source_filename = 'console' THEN 'HIRE' ELSE 'MIGRATION' END;
        continuity := 'NEW'; continuity_dimensions := NULL;
        IF v_rehires = 0 THEN
            hire_date := e.hire_on;
        ELSE
            SELECT min(entity_try_iso_date(l.effective_date)) INTO hire_date
            FROM employee_lifecycle_events l
            WHERE l.org_id = p_org AND l.employee_id = e.id AND l.state = 'APPLIED' AND l.event_type = 'ONBOARD'
              AND entity_try_iso_date(l.effective_date) < v_first_rh;
            IF hire_date IS NULL AND e.bound_from < v_first_rh THEN
                hire_date := e.bound_from;
            END IF;
            IF hire_date IS NULL THEN
                SELECT min(s.valid_from) INTO hire_date FROM employment_assignments s
                WHERE s.org_id = p_org AND s.employee_id = e.id AND s.superseded_at IS NULL
                  AND s.valid_from < v_first_rh;
            END IF;
        END IF;
        IF hire_date IS NULL THEN
            hire_date := e.created_on; needs_confirmation := true;
            finding_kind := 'HIRE_DATE_UNKNOWN'; finding_detail := jsonb_build_object('fallback', 'created_at', 'hire_date', hire_date);
            period_no := NULL; RETURN NEXT; period_no := 1; finding_kind := NULL; finding_detail := NULL;
        END IF;
        service_start_date := hire_date;
        v_open := true; v_closed_by := NULL; v_onboarded := v_rehires = 0; v_gt_ent := NULL;

        SELECT min(entity_try_iso_date(l.effective_date)) INTO v_first_ev FROM employee_lifecycle_events l
        WHERE l.org_id = p_org AND l.employee_id = e.id AND l.state = 'APPLIED'
          AND l.event_type NOT IN ('ONBOARD', 'REHIRE', 'RESCIND');
        IF v_first_ev < hire_date THEN
            finding_kind := 'HIRE_DATE_AFTER_FIRST_EVENT';
            finding_detail := jsonb_build_object('hire_date', hire_date, 'first_event_date', v_first_ev);
            period_no := NULL; RETURN NEXT; period_no := 1; finding_kind := NULL; finding_detail := NULL;
        END IF;

        FOR ev IN
            SELECT l.id, l.event_type, l.to_status, entity_try_iso_date(l.effective_date) AS on_date,
                   (SELECT c.exit_reason_code FROM employee_exit_cases c
                    WHERE c.org_id = l.org_id AND c.exit_lifecycle_event_id = l.id) AS reason
            FROM employee_lifecycle_events l
            WHERE l.org_id = p_org AND l.employee_id = e.id AND l.state = 'APPLIED' AND l.event_type <> 'RESCIND'
              AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v
                              WHERE v.org_id = l.org_id AND v.voids_event_id = l.id AND v.state = 'APPLIED')
            ORDER BY entity_try_iso_date(l.effective_date) NULLS LAST, COALESCE(l.applied_at, l.created_at), l.id
        LOOP
            IF ev.on_date IS NULL THEN
                finding_kind := 'EVENT_DATE_UNREADABLE'; finding_detail := jsonb_build_object('event_id', ev.id);
                period_no := period_no; RETURN NEXT; finding_kind := NULL; finding_detail := NULL;
                CONTINUE;
            END IF;
            IF ev.event_type IN ('TERMINATE', 'OFFBOARD') THEN
                IF v_open THEN
                    v_open := false; v_closed_by := ev.id; exit_date := ev.on_date; exit_reason_code := ev.reason;
                ELSE
                    finding_kind := 'CLOSE_WITHOUT_OPEN_EMPLOYMENT'; finding_detail := jsonb_build_object('event_id', ev.id);
                END IF;
            ELSIF ev.event_type = 'EXIT_REVERSAL' THEN
                IF NOT v_open AND v_closed_by IS NOT NULL THEN
                    v_open := true; v_closed_by := NULL; exit_date := NULL; exit_reason_code := NULL;
                ELSE
                    finding_kind := 'REVERSAL_WITHOUT_CLOSE'; finding_detail := jsonb_build_object('event_id', ev.id);
                END IF;
            ELSIF ev.event_type = 'ONBOARD' THEN
                IF v_open AND NOT v_onboarded AND ev.on_date >= hire_date THEN
                    hire_date := ev.on_date; service_start_date := ev.on_date;
                END IF;
                v_onboarded := true;
            ELSIF ev.event_type = 'REHIRE' THEN
                IF v_open THEN
                    finding_kind := 'REHIRE_WITHOUT_PRIOR_CLOSE'; finding_detail := jsonb_build_object('event_id', ev.id);
                ELSE
                    period_no := period_no + 1; finding_kind := NULL;
                    RETURN QUERY SELECT * FROM employment_backfill_close_row(e.id, period_no - 1, hire_date, exit_date,
                        exit_reason_code, cause, continuity, continuity_dimensions, service_start_date, needs_confirmation,
                        p_org, v_gt_ent);
                    hire_date := ev.on_date; exit_date := NULL; exit_reason_code := NULL;
                    cause := 'REHIRE'; continuity := 'REHIRE'; continuity_dimensions := NULL;
                    service_start_date := ev.on_date; needs_confirmation := false;
                    v_open := true; v_closed_by := NULL; v_onboarded := false; v_gt_ent := NULL;
                END IF;
            ELSIF ev.event_type = 'GROUP_TRANSFER' THEN
                SELECT g.start_date, g.continuity, g.from_legal_entity_id, g.to_legal_entity_id INTO gt
                FROM employee_group_transfers g WHERE g.org_id = p_org AND g.lifecycle_event_id = ev.id;
                IF NOT v_open THEN
                    finding_kind := 'GROUP_TRANSFER_WITHOUT_OPEN_EMPLOYMENT'; finding_detail := jsonb_build_object('event_id', ev.id);
                ELSIF gt.start_date IS NULL THEN
                    finding_kind := 'GROUP_TRANSFER_FACTS_MISSING'; finding_detail := jsonb_build_object('event_id', ev.id);
                ELSE
                    exit_date := gt.start_date - 1; exit_reason_code := 'GROUP_TRANSFER';
                    RETURN QUERY SELECT * FROM employment_backfill_close_row(e.id, period_no, hire_date, exit_date,
                        exit_reason_code, cause, continuity, continuity_dimensions, service_start_date, needs_confirmation,
                        p_org, gt.from_legal_entity_id);
                    period_no := period_no + 1;
                    hire_date := gt.start_date; exit_date := NULL; exit_reason_code := NULL;
                    cause := 'GROUP_TRANSFER'; continuity := gt.continuity;
                    continuity_dimensions := jsonb_build_object('severance', gt.continuity);
                    IF gt.continuity = 'SETTLED' THEN service_start_date := gt.start_date; END IF;
                    needs_confirmation := false; v_onboarded := true;
                    v_gt_ent := gt.to_legal_entity_id;
                END IF;
            END IF;
            IF finding_kind IS NOT NULL THEN
                RETURN QUERY SELECT e.id, NULL::int, NULL::date, NULL::date, NULL::text, NULL::uuid, NULL::text,
                    NULL::text, NULL::jsonb, NULL::date, NULL::boolean, finding_kind, finding_detail;
                finding_kind := NULL; finding_detail := NULL;
            END IF;
        END LOOP;

        -- The current period: employees.hire_on is its hire date unless a 전적
        -- opened it (a 전적 does not rewrite employees.hire_date).
        IF period_no > 1 AND cause = 'REHIRE' AND e.hire_on IS NOT NULL THEN
            hire_date := e.hire_on; service_start_date := e.hire_on;
        END IF;
        IF e.employment_status = 'EXITED' AND v_open THEN
            IF e.exit_on IS NOT NULL AND e.exit_on >= hire_date THEN
                exit_date := e.exit_on;
                RETURN QUERY SELECT e.id, NULL::int, NULL::date, NULL::date, NULL::text, NULL::uuid, NULL::text, NULL::text,
                    NULL::jsonb, NULL::date, NULL::boolean, 'EXITED_WITHOUT_TERMINATE'::text,
                    jsonb_build_object('closed_from', 'employees.exit_on', 'exit_date', e.exit_on);
            ELSE
                RETURN QUERY SELECT e.id, NULL::int, NULL::date, NULL::date, NULL::text, NULL::uuid, NULL::text, NULL::text,
                    NULL::jsonb, NULL::date, NULL::boolean, 'EXITED_WITHOUT_EXIT_DATE'::text,
                    jsonb_build_object('exit_on', e.exit_on);
            END IF;
        ELSIF e.employment_status <> 'EXITED' AND NOT v_open THEN
            RETURN QUERY SELECT e.id, NULL::int, NULL::date, NULL::date, NULL::text, NULL::uuid, NULL::text, NULL::text,
                NULL::jsonb, NULL::date, NULL::boolean, 'ACTIVE_AFTER_CLOSE'::text,
                jsonb_build_object('status', e.employment_status, 'exit_date', exit_date);
        END IF;
        RETURN QUERY SELECT * FROM employment_backfill_close_row(e.id, period_no, hire_date, exit_date,
            exit_reason_code, cause, continuity, continuity_dimensions, service_start_date, needs_confirmation,
            p_org, v_gt_ent);

        -- 법인 changed with no 전적 (a pre-E-S3b change, IT F11/F12).
        v_prev_ent := NULL;
        FOR a IN
            SELECT s.legal_entity_id AS ent, s.cause AS why, s.valid_from FROM employment_assignments s
            WHERE s.org_id = p_org AND s.employee_id = e.id AND s.superseded_at IS NULL AND s.legal_entity_id IS NOT NULL
            ORDER BY s.valid_from
        LOOP
            IF v_prev_ent IS NOT NULL AND a.ent <> v_prev_ent AND a.why <> 'GROUP_TRANSFER' THEN
                RETURN QUERY SELECT e.id, NULL::int, NULL::date, NULL::date, NULL::text, NULL::uuid, NULL::text, NULL::text,
                    NULL::jsonb, NULL::date, NULL::boolean, 'ENTITY_CHANGED_WITHOUT_GROUP_TRANSFER'::text,
                    jsonb_build_object('from_legal_entity_id', v_prev_ent, 'to_legal_entity_id', a.ent, 'on', a.valid_from);
            END IF;
            v_prev_ent := a.ent;
        END LOOP;
    END LOOP;
END $$;

-- One period row, with its 법인 (the 전적 fact when given, else the assignment
-- covering its hire date) and the findings a period alone can show.
CREATE FUNCTION employment_backfill_close_row(
    p_employee UUID, p_no INT, p_hire DATE, p_exit DATE, p_reason TEXT, p_cause TEXT, p_continuity TEXT,
    p_dims JSONB, p_service DATE, p_confirm BOOLEAN, p_org UUID, p_entity UUID DEFAULT NULL)
RETURNS TABLE (
    employee_id UUID, period_no INT, hire_date DATE, exit_date DATE, exit_reason_code TEXT, legal_entity_id UUID,
    cause TEXT, continuity TEXT, continuity_dimensions JSONB, service_start_date DATE, needs_confirmation BOOLEAN,
    finding_kind TEXT, finding_detail JSONB)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_entity UUID := p_entity;
BEGIN
    IF v_entity IS NULL THEN
        SELECT s.legal_entity_id INTO v_entity FROM employment_assignments s
        WHERE s.org_id = p_org AND s.employee_id = p_employee AND s.superseded_at IS NULL
          AND s.legal_entity_id IS NOT NULL
          AND s.valid_from <= COALESCE(p_exit, p_hire) AND (s.valid_to IS NULL OR s.valid_to > p_hire)
        ORDER BY (s.valid_from <= p_hire) DESC, s.valid_from DESC LIMIT 1;
    END IF;
    IF v_entity IS NULL THEN
        RETURN QUERY SELECT p_employee, NULL::int, NULL::date, NULL::date, NULL::text, NULL::uuid, NULL::text,
            NULL::text, NULL::jsonb, NULL::date, NULL::boolean, 'LEGAL_ENTITY_UNKNOWN'::text,
            jsonb_build_object('period_no', p_no, 'hire_date', p_hire);
    END IF;
    IF p_exit IS NOT NULL AND p_exit < p_hire THEN
        RETURN QUERY SELECT p_employee, NULL::int, NULL::date, NULL::date, NULL::text, NULL::uuid, NULL::text,
            NULL::text, NULL::jsonb, NULL::date, NULL::boolean, 'EXIT_BEFORE_HIRE'::text,
            jsonb_build_object('period_no', p_no, 'hire_date', p_hire, 'exit_date', p_exit);
        p_exit := NULL;   -- the close is not written; the finding carries it
    END IF;
    RETURN QUERY SELECT p_employee, p_no, p_hire, p_exit, CASE WHEN p_exit IS NOT NULL THEN p_reason END, v_entity,
        p_cause, p_continuity, p_dims, p_service, p_confirm, NULL::text, NULL::jsonb;
END $$;

-- ---------------------------------------------------------------------------
-- 4b. employment_backfill(org): M2, idempotent. Writes the plan: the bound
-- head is filled when its opening date falls inside a period, other periods
-- get new heads; then employment_id on the scoped rows that have none, then
-- the findings. Only NULL -> value writes, so a rerun on unchanged data writes
-- nothing (and a rerun after new events catches up, which LC-B2 relies on).
-- Returns the number of rows written.
CREATE FUNCTION employment_backfill(p_org UUID) RETURNS BIGINT
LANGUAGE plpgsql AS $$
DECLARE
    p        RECORD;
    v_head   UUID;
    v_prev   UUID;
    v_emp    UUID;
    v_bound  RECORD;
    v_n      BIGINT := 0;
    v_rows   BIGINT;
    v_last   DATE;
BEGIN
    IF to_regclass('pg_temp.employment_backfill_plan_rows') IS NULL THEN
        CREATE TEMP TABLE employment_backfill_plan_rows ON COMMIT DROP AS
            SELECT * FROM employment_backfill_plan(p_org) WITH NO DATA;
        CREATE TEMP TABLE employment_backfill_current (employee_id UUID, employment_id UUID) ON COMMIT DROP;
    END IF;
    TRUNCATE employment_backfill_plan_rows, employment_backfill_current;
    INSERT INTO employment_backfill_plan_rows SELECT * FROM employment_backfill_plan(p_org);

    -- Periods that would overlap a neighbour are not written (finding instead).
    INSERT INTO employment_backfill_plan_rows (employee_id, finding_kind, finding_detail)
    SELECT a.employee_id, 'PERIOD_OVERLAP', jsonb_build_object('period_no', b.period_no, 'hire_date', b.hire_date,
           'previous_exit_date', a.exit_date)
    FROM employment_backfill_plan_rows a JOIN employment_backfill_plan_rows b
      ON b.employee_id = a.employee_id AND b.period_no = a.period_no + 1
    WHERE a.finding_kind IS NULL AND b.finding_kind IS NULL AND b.hire_date <= a.exit_date;
    DELETE FROM employment_backfill_plan_rows b USING employment_backfill_plan_rows a
    WHERE a.finding_kind IS NULL AND b.finding_kind IS NULL AND b.employee_id = a.employee_id
      AND b.period_no > a.period_no AND b.hire_date <= a.exit_date;

    v_emp := NULL;
    FOR p IN
        SELECT * FROM employment_backfill_plan_rows WHERE finding_kind IS NULL ORDER BY employee_id, period_no
    LOOP
        IF v_emp IS DISTINCT FROM p.employee_id THEN
            v_emp := p.employee_id; v_prev := NULL;
            SELECT h.id, h.employee_id, (h.valid_from AT TIME ZONE 'Asia/Seoul')::date AS from_on INTO v_bound
            FROM employment_source_bindings b JOIN employment_heads h ON h.org_id = b.org_id AND h.id = b.employment_id
            WHERE b.org_id = p_org AND b.employee_id = p.employee_id;
        END IF;
        -- An earlier run's head for this period, else the bound head when it opened inside it.
        SELECT h.id INTO v_head FROM employment_heads h
        WHERE h.org_id = p_org AND h.employee_id = p.employee_id AND h.hire_date = p.hire_date;
        IF v_head IS NULL AND v_bound.id IS NOT NULL AND v_bound.employee_id IS NULL
           AND v_bound.from_on >= p.hire_date AND (p.exit_date IS NULL OR v_bound.from_on <= p.exit_date) THEN
            v_head := v_bound.id;
        END IF;
        IF v_head IS NULL THEN
            INSERT INTO employment_heads (org_id, valid_from, employee_id, hire_date)
            VALUES (p_org, (p.hire_date::timestamp AT TIME ZONE 'Asia/Seoul'), p.employee_id, p.hire_date)
            RETURNING id INTO v_head;
            v_n := v_n + 1;
        END IF;
        UPDATE employment_heads h SET
            employee_id = COALESCE(h.employee_id, p.employee_id),
            hire_date = COALESCE(h.hire_date, p.hire_date),
            legal_entity_id = COALESCE(h.legal_entity_id, p.legal_entity_id),
            service_start_date = COALESCE(h.service_start_date, p.service_start_date),
            severance_start_date = COALESCE(h.severance_start_date, p.service_start_date),
            cause = COALESCE(h.cause, p.cause),
            continuity = COALESCE(h.continuity, p.continuity),
            continuity_dimensions = COALESCE(h.continuity_dimensions, p.continuity_dimensions),
            predecessor_employment_id = COALESCE(h.predecessor_employment_id, v_prev),
            needs_confirmation = CASE WHEN h.hire_date IS NULL THEN p.needs_confirmation ELSE h.needs_confirmation END,
            exit_date = COALESCE(h.exit_date, p.exit_date),
            exit_reason_code = CASE WHEN h.exit_date IS NULL THEN p.exit_reason_code ELSE h.exit_reason_code END,
            valid_to = CASE WHEN h.exit_date IS NULL AND p.exit_date IS NOT NULL
                            THEN ((p.exit_date + 1)::timestamp AT TIME ZONE 'Asia/Seoul') ELSE h.valid_to END
        WHERE h.org_id = p_org AND h.id = v_head
          AND (h.employee_id IS NULL OR h.hire_date IS NULL OR h.cause IS NULL
               OR (h.legal_entity_id IS NULL AND p.legal_entity_id IS NOT NULL)
               OR (h.predecessor_employment_id IS NULL AND v_prev IS NOT NULL)
               OR (h.exit_date IS NULL AND p.exit_date IS NOT NULL));
        GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
        v_prev := v_head;
    END LOOP;

    -- A bound head whose opening fell in no period stays as it is.
    INSERT INTO employment_backfill_plan_rows (employee_id, finding_kind, finding_detail)
    SELECT b.employee_id, 'BOUND_HEAD_UNMATCHED',
           jsonb_build_object('employment_id', h.id, 'valid_from', h.valid_from)
    FROM employment_source_bindings b JOIN employment_heads h ON h.org_id = b.org_id AND h.id = b.employment_id
    JOIN employees x ON x.org_id = b.org_id AND x.id = b.employee_id
    WHERE b.org_id = p_org AND h.employee_id IS NULL
      AND x.employment_status <> 'VOIDED' AND x.merged_into_employee_id IS NULL;

    -- employment_id on the scoped rows, by date inside [hire_date, exit_date].
    UPDATE employment_assignments t SET employment_id = h.id FROM employment_heads h
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND h.org_id = t.org_id AND h.employee_id = t.employee_id
      AND t.valid_from BETWEEN h.hire_date AND COALESCE(h.exit_date, 'infinity'::date);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    UPDATE employee_contracts t SET employment_id = h.id FROM employment_heads h
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND h.org_id = t.org_id AND h.employee_id = t.employee_id
      AND t.start_date BETWEEN h.hire_date AND COALESCE(h.exit_date, 'infinity'::date);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    UPDATE employee_contract_wages t SET employment_id = h.id FROM employment_heads h
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND h.org_id = t.org_id AND h.employee_id = t.employee_id
      AND t.effective_from BETWEEN h.hire_date AND COALESCE(h.exit_date, 'infinity'::date);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    UPDATE employee_exit_cases t SET employment_id = h.id FROM employment_heads h
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND h.org_id = t.org_id AND h.employee_id = t.employee_id
      AND t.effective_exit_date BETWEEN h.hire_date AND COALESCE(h.exit_date, 'infinity'::date);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    UPDATE employee_lifecycle_events t SET employment_id = h.id FROM employment_heads h
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND h.org_id = t.org_id AND h.employee_id = t.employee_id
      AND entity_try_iso_date(t.effective_date) BETWEEN h.hire_date AND COALESCE(h.exit_date, 'infinity'::date);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    -- A REHIRE / ONBOARD recorded before its period starts belongs to the period it opens.
    UPDATE employee_lifecycle_events t SET employment_id = (
        SELECT h.id FROM employment_heads h
        WHERE h.org_id = t.org_id AND h.employee_id = t.employee_id
          AND h.hire_date > entity_try_iso_date(t.effective_date)
        ORDER BY h.hire_date LIMIT 1)
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND t.event_type IN ('REHIRE', 'ONBOARD')
      AND EXISTS (SELECT 1 FROM employment_heads h WHERE h.org_id = t.org_id AND h.employee_id = t.employee_id
                  AND h.hire_date > entity_try_iso_date(t.effective_date));
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    UPDATE employee_group_transfers t SET
        from_employment_id = COALESCE(t.from_employment_id, (SELECT h.id FROM employment_heads h
            WHERE h.org_id = t.org_id AND h.employee_id = t.employee_id AND h.exit_date = t.start_date - 1)),
        to_employment_id = COALESCE(t.to_employment_id, (SELECT h.id FROM employment_heads h
            WHERE h.org_id = t.org_id AND h.employee_id = t.employee_id AND h.hire_date = t.start_date))
    WHERE t.org_id = p_org AND (t.from_employment_id IS NULL OR t.to_employment_id IS NULL)
      AND EXISTS (SELECT 1 FROM employment_heads h WHERE h.org_id = t.org_id AND h.employee_id = t.employee_id
                  AND (h.exit_date = t.start_date - 1 OR h.hire_date = t.start_date));
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    -- One row per person: the current employment (open, else the latest).
    INSERT INTO employment_backfill_current
    SELECT DISTINCT ON (h.employee_id) h.employee_id, h.id FROM employment_heads h
    WHERE h.org_id = p_org AND h.employee_id IS NOT NULL
    ORDER BY h.employee_id, (h.exit_date IS NULL) DESC, h.hire_date DESC;
    UPDATE employee_employment_profiles t SET employment_id = c.employment_id FROM employment_backfill_current c
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND t.employee_id = c.employee_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    UPDATE employee_register_facts t SET employment_id = c.employment_id FROM employment_backfill_current c
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND t.employee_id = c.employee_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    UPDATE employee_leave_balances t SET employment_id = c.employment_id FROM employment_backfill_current c
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND t.employee_id = c.employee_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;
    -- 연차 by year: the employment that covers the year, latest first, else the current one.
    UPDATE annual_leave_obligations t SET employment_id = COALESCE(
        (SELECT h.id FROM employment_heads h
         WHERE h.org_id = t.org_id AND h.employee_id = t.employee_id
           AND daterange(h.hire_date, h.exit_date, '[]') && daterange(make_date(t.leave_year, 1, 1), make_date(t.leave_year, 12, 31), '[]')
         ORDER BY h.hire_date DESC LIMIT 1),
        (SELECT c.employment_id FROM employment_backfill_current c WHERE c.employee_id = t.employee_id))
    WHERE t.org_id = p_org AND t.employment_id IS NULL
      AND EXISTS (SELECT 1 FROM employment_heads h WHERE h.org_id = t.org_id AND h.employee_id = t.employee_id);
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;

    INSERT INTO employment_backfill_plan_rows (employee_id, finding_kind, finding_detail)
    SELECT t.employee_id, 'ASSIGNMENT_OUTSIDE_EMPLOYMENT', jsonb_build_object('assignment_id', t.id, 'valid_from', t.valid_from)
    FROM employment_assignments t
    WHERE t.org_id = p_org AND t.employment_id IS NULL AND t.superseded_at IS NULL AND t.cause <> 'MIGRATION_UNMAPPED'
      AND EXISTS (SELECT 1 FROM employment_heads h WHERE h.org_id = t.org_id AND h.employee_id = t.employee_id);

    INSERT INTO employment_backfill_findings (org_id, employee_id, employment_id, kind, detail, fingerprint)
    SELECT p_org, f.employee_id,
           (f.finding_detail ->> 'employment_id')::uuid,
           f.finding_kind, f.finding_detail, md5(f.finding_kind || f.finding_detail::text)
    FROM employment_backfill_plan_rows f WHERE f.finding_kind IS NOT NULL
    ON CONFLICT (org_id, employee_id, fingerprint) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT; v_n := v_n + v_rows;

    TRUNCATE employment_backfill_plan_rows;
    RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION employment_backfill_plan(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION employment_backfill_close_row(UUID, INT, DATE, DATE, TEXT, TEXT, TEXT, JSONB, DATE, BOOLEAN, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION employment_backfill(UUID) FROM PUBLIC;

-- M2 for every tenant, now. A tenant with no people writes nothing.
SELECT employment_backfill(o.id) FROM organizations o ORDER BY o.id;
