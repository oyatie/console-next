-- ATT-BUILD S2 (decision #22, AT §4.14, frames A1-*, A3-*): HR-recorded 근태.
-- A save is one batch in one transaction; each cell is an append-only entry.
-- The current value of a person-day is its newest entry whose batch is not
-- undone; 정정 supersedes with a reason, 기록 취소 is a VOID entry, and a
-- 재기록 after it is a new entry (restore). 일괄 취소 marks the batch undone
-- until the month closes. Raw 기록 is evidence; 인정 is derived on read from
-- 근무 일정 and 승인 (S3), never stored as a typed value.
-- Numbered head+1 of hard/att-schedules (0319); INTEG renumbers.
SET LOCAL lock_timeout = '2s';

-- console-gate: audited-table attendance_batches
CREATE TABLE attendance_batches (
    org_id                UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
    source                TEXT        NOT NULL CHECK (source IN ('MANUAL', 'BULK', 'PASTE', 'SCHEDULE', 'IMPORT', 'CORRECTION', 'VOID')),
    evidence_kind         TEXT        NOT NULL CHECK (evidence_kind IN ('PAPER_SHEET', 'SUPERVISOR_CONFIRM', 'DEVICE_FILE', 'EMPLOYEE_STATEMENT', 'OTHER')),
    evidence_note         TEXT        NULL CHECK (evidence_note IS NULL OR char_length(btrim(evidence_note)) BETWEEN 1 AND 500),
    confirmer_employee_id UUID        NULL,
    cells                 INTEGER     NOT NULL CHECK (cells BETWEEN 1 AND 10000),
    undone_at             TIMESTAMPTZ NULL,
    undone_by             UUID        NULL,
    undo_reason           TEXT        NULL,
    created_by            UUID        NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    idempotency_key       TEXT        NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
    request_fingerprint   TEXT        NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (id, org_id),
    UNIQUE (org_id, idempotency_key),
    FOREIGN KEY (confirmer_employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (undone_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CHECK (evidence_kind <> 'SUPERVISOR_CONFIRM' OR confirmer_employee_id IS NOT NULL),
    CHECK ((undone_at IS NULL) = (undone_by IS NULL) AND (undone_at IS NULL) = (undo_reason IS NULL))
);

-- console-gate: audited-table attendance_entries
CREATE TABLE attendance_entries (
    org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id            UUID        NOT NULL DEFAULT gen_random_uuid(),
    batch_id      UUID        NOT NULL,
    employee_id   UUID        NOT NULL,
    work_date     DATE        NOT NULL,
    kind          TEXT        NOT NULL CHECK (kind IN ('TIMES', 'CLOCK_IN_ONLY', 'ABSENT', 'OUTSIDE_WORK', 'BUSINESS_TRIP', 'VOID')),
    segments      JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(segments) = 'array'),
    supersedes_id UUID        NULL,
    reason        TEXT        NULL CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 500),
    created_by    UUID        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    FOREIGN KEY (batch_id, org_id) REFERENCES attendance_batches(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (supersedes_id, org_id) REFERENCES attendance_entries(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CHECK ((kind IN ('TIMES', 'CLOCK_IN_ONLY')) = (jsonb_array_length(segments) > 0)),
    CHECK (kind <> 'VOID' OR (supersedes_id IS NOT NULL AND reason IS NOT NULL))
);
CREATE INDEX attendance_entries_day_idx ON attendance_entries (org_id, work_date, employee_id, created_at DESC);
CREATE INDEX attendance_entries_person_idx ON attendance_entries (org_id, employee_id, work_date);
CREATE INDEX attendance_entries_batch_idx ON attendance_entries (org_id, batch_id);

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['attendance_batches', 'attendance_entries'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid)', t);
        EXECUTE format('CREATE TRIGGER trg_%I_org_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable()', t, t);
        EXECUTE format('REVOKE ALL PRIVILEGES ON %I FROM PUBLIC, console_rt', t);
    END LOOP;
END $$;
GRANT SELECT, INSERT ON attendance_batches, attendance_entries TO console_rt;
GRANT UPDATE (undone_at, undone_by, undo_reason) ON attendance_batches TO console_rt;

-- Entries are append-only; a batch only goes from live to undone, once.
CREATE FUNCTION attendance_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'attendance_entries is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_attendance_entries_append_only
    BEFORE UPDATE OR DELETE ON attendance_entries FOR EACH ROW EXECUTE FUNCTION attendance_entries_append_only();
CREATE FUNCTION attendance_batches_undo_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR OLD.undone_at IS NOT NULL OR NEW.undone_at IS NULL
       OR (NEW.id, NEW.org_id, NEW.source, NEW.evidence_kind, NEW.cells, NEW.created_by, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.source, OLD.evidence_kind, OLD.cells, OLD.created_by, OLD.created_at)
    THEN
        RAISE EXCEPTION 'attendance batch only moves from live to undone' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_attendance_batches_undo_only
    BEFORE UPDATE OR DELETE ON attendance_batches FOR EACH ROW EXECUTE FUNCTION attendance_batches_undo_only();

-- A closed month is closed for writes too: an entry whose work date falls in
-- a month closed for the tenant or for the person's branch on that date is
-- refused here as well as by the domain (AT-30 closed-period guard).
CREATE FUNCTION attendance_entries_closed_month() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM attendance_month_closes c
         WHERE c.org_id = NEW.org_id AND c.month = date_trunc('month', NEW.work_date)::date
           AND (c.branch_id IS NULL OR c.branch_id IN (
               SELECT w.default_branch_id FROM employment_assignments a
                 JOIN workplaces w ON w.org_id = a.org_id AND w.id = a.workplace_id
                WHERE a.org_id = NEW.org_id AND a.employee_id = NEW.employee_id AND a.superseded_at IS NULL
                  AND a.valid_from <= NEW.work_date AND (a.valid_to IS NULL OR a.valid_to > NEW.work_date)))
    ) THEN
        RAISE EXCEPTION 'entry_month_closed' USING ERRCODE = '25006';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_attendance_entries_closed_month
    BEFORE INSERT ON attendance_entries FOR EACH ROW EXECUTE FUNCTION attendance_entries_closed_month();

COMMENT ON TABLE attendance_batches IS 'ATT S2: one save of 근태 기록, one transaction, with its 근거 and 일괄 취소';
COMMENT ON COLUMN attendance_batches.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN attendance_batches.id IS 'pd:none — batch id';
COMMENT ON COLUMN attendance_batches.source IS 'pd:none — MANUAL | BULK | PASTE | SCHEDULE | IMPORT | CORRECTION | VOID';
COMMENT ON COLUMN attendance_batches.evidence_kind IS 'pd:none — 근거: 출근부 · 관리자 확인 · 타각기 파일 · 본인 진술 · 그 밖';
COMMENT ON COLUMN attendance_batches.evidence_note IS 'pd:personal — 근거 memo';
COMMENT ON COLUMN attendance_batches.confirmer_employee_id IS 'pd:personal — 확인자 (관리자 확인), employees.id';
COMMENT ON COLUMN attendance_batches.cells IS 'pd:none — cells saved';
COMMENT ON COLUMN attendance_batches.undone_at IS 'pd:none — 일괄 취소 time';
COMMENT ON COLUMN attendance_batches.undone_by IS 'pd:personal — who undid it';
COMMENT ON COLUMN attendance_batches.undo_reason IS 'pd:personal — why it was undone';
COMMENT ON COLUMN attendance_batches.created_by IS 'pd:personal — who saved it';
COMMENT ON COLUMN attendance_batches.created_at IS 'pd:none — when saved';
COMMENT ON COLUMN attendance_batches.idempotency_key IS 'pd:none — request key';
COMMENT ON COLUMN attendance_batches.request_fingerprint IS 'pd:none — request digest';
COMMENT ON TABLE attendance_entries IS 'ATT S2: one person-day value as recorded; append-only';
COMMENT ON COLUMN attendance_entries.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN attendance_entries.id IS 'pd:none — entry id';
COMMENT ON COLUMN attendance_entries.batch_id IS 'pd:none — the save it came in';
COMMENT ON COLUMN attendance_entries.employee_id IS 'pd:personal — 직원 레코드 식별자 - employees.id';
COMMENT ON COLUMN attendance_entries.work_date IS 'pd:personal — 근무일';
COMMENT ON COLUMN attendance_entries.kind IS 'pd:personal — TIMES | CLOCK_IN_ONLY | ABSENT | OUTSIDE_WORK | BUSINESS_TRIP | VOID';
COMMENT ON COLUMN attendance_entries.segments IS 'pd:personal — recorded spans in minutes of the work date';
COMMENT ON COLUMN attendance_entries.supersedes_id IS 'pd:none — the entry this one replaces (정정 · 기록 취소 · 재기록)';
COMMENT ON COLUMN attendance_entries.reason IS 'pd:personal — 정정 or 기록 취소 사유';
COMMENT ON COLUMN attendance_entries.created_by IS 'pd:personal — who recorded it';
COMMENT ON COLUMN attendance_entries.created_at IS 'pd:none — when recorded';

-- #27: a save, an undo, a 정정 or a 기록 취소 re-reads the 근태 views.
DO $$
BEGIN
    IF to_regclass('public.realtime_topic_map') IS NOT NULL THEN
        INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
            ('attendance_batch', 'attendance.entries.save', 'attendance_day', false),
            ('attendance_batch', 'attendance.entries.undo', 'attendance_day', false),
            ('attendance_entry', 'attendance.entry.correct', 'attendance_day', false),
            ('attendance_entry', 'attendance.entry.void', 'attendance_day', false)
        ON CONFLICT DO NOTHING;
    END IF;
END $$;
