-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Add employee pay-group assignments, attendance cutoff rules, and pay-group-scoped period locks.
-- contract-of: 0280
-- Wave 5 (BG-5): Multi-pay-group employee assignments, optional pay-group attendance cutoff rules,
-- and pay-group-scoped payroll period locks.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. Effective-dated employee pay-group membership (at most one active group per employee per date).
-- ---------------------------------------------------------------------------
-- console-gate: audited-table employee_pay_group_assignments
CREATE TABLE employee_pay_group_assignments (
    org_id                 UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    id                     UUID        NOT NULL DEFAULT gen_random_uuid(),
    employee_id            UUID        NOT NULL,
    pay_group_id           UUID        NOT NULL,
    effective_from         DATE        NOT NULL,
    effective_to_exclusive DATE        NULL,
    superseded_at          TIMESTAMPTZ NULL,
    created_by             UUID        NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    CONSTRAINT employee_pay_group_assignments_employee_fk
        FOREIGN KEY (org_id, employee_id) REFERENCES employees(org_id, id) ON DELETE CASCADE,
    CONSTRAINT employee_pay_group_assignments_group_fk
        FOREIGN KEY (org_id, pay_group_id) REFERENCES pay_groups(org_id, id) ON DELETE RESTRICT,
    CONSTRAINT employee_pay_group_assignments_valid_span
        CHECK (effective_to_exclusive IS NULL OR effective_to_exclusive > effective_from)
);

COMMENT ON TABLE employee_pay_group_assignments IS
    'Effective-dated pay-group membership per employee for legal entities with multiple pay groups.';
COMMENT ON COLUMN employee_pay_group_assignments.org_id IS
    'pd:none — tenant partition key';
COMMENT ON COLUMN employee_pay_group_assignments.id IS
    'pd:none — surrogate assignment identifier';
COMMENT ON COLUMN employee_pay_group_assignments.employee_id IS
    'pd:personal — employee placed into a pay group';
COMMENT ON COLUMN employee_pay_group_assignments.pay_group_id IS
    'pd:none — target pay group identifier';
COMMENT ON COLUMN employee_pay_group_assignments.effective_from IS
    'pd:personal — inclusive start date of pay-group membership';
COMMENT ON COLUMN employee_pay_group_assignments.effective_to_exclusive IS
    'pd:personal — exclusive end date of pay-group membership; NULL while open-ended';
COMMENT ON COLUMN employee_pay_group_assignments.superseded_at IS
    'pd:none — timestamp when replaced by a newer same-day or retroactive assignment';
COMMENT ON COLUMN employee_pay_group_assignments.created_by IS
    'pd:personal — actor user id who recorded the assignment';
COMMENT ON COLUMN employee_pay_group_assignments.created_at IS
    'pd:none — row creation timestamp';

CREATE UNIQUE INDEX idx_employee_pay_group_assignments_open_one
    ON employee_pay_group_assignments (org_id, employee_id)
    WHERE superseded_at IS NULL AND effective_to_exclusive IS NULL;

CREATE INDEX idx_employee_pay_group_assignments_group
    ON employee_pay_group_assignments (org_id, pay_group_id, effective_from)
    WHERE superseded_at IS NULL;

CREATE INDEX idx_employee_pay_group_assignments_employee
    ON employee_pay_group_assignments (org_id, employee_id, effective_from)
    WHERE superseded_at IS NULL;

CREATE TRIGGER trg_employee_pay_group_assignments_org_immutable
    BEFORE UPDATE ON employee_pay_group_assignments
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

CREATE TRIGGER trg_employee_pay_group_assignments_no_delete
    BEFORE DELETE ON employee_pay_group_assignments
    FOR EACH ROW EXECUTE FUNCTION platform_append_only_immutable();

ALTER TABLE employee_pay_group_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_pay_group_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_pay_group_assignments
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL PRIVILEGES ON employee_pay_group_assignments FROM PUBLIC, console_rt;
GRANT SELECT, INSERT, UPDATE (effective_to_exclusive, superseded_at)
    ON employee_pay_group_assignments TO console_rt;

-- ---------------------------------------------------------------------------
-- 2. Optional attendance cutoff rule on pay_groups and snapshot date on payroll_draft_runs.
-- ---------------------------------------------------------------------------
ALTER TABLE pay_groups
    ADD COLUMN attendance_cutoff_rule JSONB NULL,
    ADD CONSTRAINT pay_groups_attendance_cutoff_object
        CHECK (attendance_cutoff_rule IS NULL OR jsonb_typeof(attendance_cutoff_rule) = 'object');

COMMENT ON COLUMN pay_groups.attendance_cutoff_rule IS
    'pd:none — optional payroll attendance cutoff calendar rule {day, month_offset}';

ALTER TABLE payroll_draft_runs
    ADD COLUMN attendance_cutoff_date DATE NULL;

COMMENT ON COLUMN payroll_draft_runs.attendance_cutoff_date IS
    'pd:none — derived payroll attendance cutoff date snapshot for this run';

-- ---------------------------------------------------------------------------
-- 3. Optional pay_group_id scope on period_locks (payroll domain only; NULL = tenant-wide).
-- ---------------------------------------------------------------------------
ALTER TABLE period_locks
    ADD COLUMN pay_group_id UUID NULL,
    ADD CONSTRAINT period_locks_pay_group_fk
        FOREIGN KEY (org_id, pay_group_id) REFERENCES pay_groups(org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT period_locks_pay_group_domain
        CHECK (domain = 'payroll' OR pay_group_id IS NULL);

COMMENT ON COLUMN period_locks.pay_group_id IS
    'pd:none — optional pay-group scope for payroll freeze windows; NULL freezes the whole tenant domain';

CREATE INDEX idx_period_locks_pay_group
    ON period_locks (org_id, domain, pay_group_id, period_start, period_end)
    WHERE pay_group_id IS NOT NULL;

CREATE OR REPLACE FUNCTION period_locks_unlock_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.unlocked_at IS NOT NULL THEN
        RAISE EXCEPTION 'period lock % is already unlocked and immutable', OLD.id
            USING ERRCODE = '25006';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.org_id IS DISTINCT FROM OLD.org_id
        OR NEW.domain IS DISTINCT FROM OLD.domain
        OR NEW.pay_group_id IS DISTINCT FROM OLD.pay_group_id
        OR NEW.period_start IS DISTINCT FROM OLD.period_start
        OR NEW.period_end IS DISTINCT FROM OLD.period_end
        OR NEW.reason IS DISTINCT FROM OLD.reason
        OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
        OR NEW.locked_by IS DISTINCT FROM OLD.locked_by
        OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
        OR NEW.unlocked_at IS NULL
    THEN
        RAISE EXCEPTION 'period lock rows only permit the one-shot unlock update'
            USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION period_lock_effective(p period_locks)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT p.unlocked_at IS NULL
        OR (
            coalesce(p.relock_at <= now(), false)
            AND NOT EXISTS (
                SELECT 1 FROM period_locks s
                WHERE s.org_id = p.org_id
                  AND s.domain = p.domain
                  AND s.pay_group_id IS NOT DISTINCT FROM p.pay_group_id
                  AND s.period_start = p.period_start
                  AND s.period_end = p.period_end
                  AND s.locked_at > p.unlocked_at
            )
        )
$$;

REVOKE ALL ON FUNCTION period_lock_effective(period_locks) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION period_lock_effective(period_locks) TO console_rt;
