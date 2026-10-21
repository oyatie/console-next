-- BE-EMP-UI (decisions #19, #21, #26, #27, #28; employee-ux final spec §10):
-- the server records behind the employee action screens. Numbered head+1 of
-- console-react-mvp 402789e6 (migrations end at 0302); INTEG renumbers.
--
-- 1. employee_exit_cases.exit_reason_code: the 퇴직 사유 asked at the exit
--    report (영 §20 8호; BW-07 exit_reason catalog, validated by the writer
--    against the tenant's codes). 0293 already reads "the case's own
--    exit_reason_code is the 사유" for an exit reported through a case; this
--    is that column. The 상실 code mapping stays HOLD (BW-08, D#9).
-- 2. appointment_notices + appointment_notice_lines: 발령 공고 with its
--    발령 번호 (YYYY-NNNN, per tenant per notice year, max+1 under an
--    advisory lock: gapless at issue and, with no DELETE grant, never
--    reused). A lifecycle event is on at most one notice (UNIQUE), so the
--    same 발령 is never announced twice. No approval step (#26).
-- 3. api_idempotency_keys: the notice issue's operation name.
-- 4. import_reconcile_checks + import_signoffs: 이관 확인 (decisions #20,
--    #25; spec E7-reconcile/E7-row/E7-signoff). One row state per applied
--    import row (CONFIRMED 확인함 / NEEDS_CHECK 확인 필요; no row = not
--    checked yet), versioned for stale writes, frozen by the run's one
--    sign-off. The sign-off records who attested the migration and the open
--    count they attested over (a warning, never a blocker: #20 Q5).
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. 퇴직 사유 on the exit case
ALTER TABLE employee_exit_cases
    ADD COLUMN exit_reason_code TEXT NULL
        CONSTRAINT employee_exit_cases_exit_reason_code_shape
        CHECK (exit_reason_code IS NULL OR char_length(btrim(exit_reason_code)) BETWEEN 1 AND 100);
COMMENT ON COLUMN employee_exit_cases.exit_reason_code IS 'pd:personal — 퇴직(해고) 사유 (영 §20 8호), BW-07 exit_reason code given at the report; the employee''s 퇴직 사유 while the case is live';

-- ---------------------------------------------------------------------------
-- 2. 발령 공고
CREATE TABLE appointment_notices (
    org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id           UUID        NOT NULL DEFAULT gen_random_uuid(),
    notice_year  INTEGER     NOT NULL
        CONSTRAINT appointment_notices_year_check CHECK (notice_year BETWEEN 1900 AND 9999),
    seq          INTEGER     NOT NULL
        CONSTRAINT appointment_notices_seq_check CHECK (seq BETWEEN 1 AND 9999),
    notice_no    TEXT        NOT NULL
        CONSTRAINT appointment_notices_no_shape CHECK (notice_no = notice_year::TEXT || '-' || lpad(seq::TEXT, 4, '0')),
    title        TEXT        NOT NULL
        CONSTRAINT appointment_notices_title_shape CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    notice_date  DATE        NOT NULL,
    note         TEXT        NULL
        CONSTRAINT appointment_notices_note_shape CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
    issued_by    UUID        NOT NULL,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    CONSTRAINT appointment_notices_seq_unique UNIQUE (org_id, notice_year, seq),
    CONSTRAINT appointment_notices_no_unique UNIQUE (org_id, notice_no),
    CONSTRAINT appointment_notices_year_of_date CHECK (notice_year = EXTRACT(YEAR FROM notice_date)::INTEGER),
    FOREIGN KEY (issued_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);
-- The list (newest first, keyset on (issued_at, id)).
CREATE INDEX appointment_notices_org_issued_idx ON appointment_notices (org_id, issued_at DESC, id DESC);

ALTER TABLE appointment_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON appointment_notices
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_appointment_notices_org_immutable BEFORE UPDATE ON appointment_notices
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

-- Issued once and never rewritten or deleted: SELECT and INSERT only.
GRANT SELECT, INSERT ON appointment_notices TO console_rt;

COMMENT ON TABLE appointment_notices IS 'BE-EMP-UI 발령 공고: one numbered announcement of lifecycle events (발령 번호 YYYY-NNNN per tenant and year)';
COMMENT ON COLUMN appointment_notices.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN appointment_notices.id IS 'pd:none — notice id';
COMMENT ON COLUMN appointment_notices.notice_year IS 'pd:none — the year the 발령 번호 counts in (the notice date''s)';
COMMENT ON COLUMN appointment_notices.seq IS 'pd:none — the 발령 번호 sequence within the year, gapless at issue';
COMMENT ON COLUMN appointment_notices.notice_no IS 'pd:none — 발령 번호 YYYY-NNNN';
COMMENT ON COLUMN appointment_notices.title IS 'pd:none — the 공고 title (e.g. 2026년 11월 정기 인사발령)';
COMMENT ON COLUMN appointment_notices.notice_date IS 'pd:none — the 공고 date printed on the notice';
COMMENT ON COLUMN appointment_notices.note IS 'pd:personal — free text printed under the notice; may name people';
COMMENT ON COLUMN appointment_notices.issued_by IS 'pd:personal — who issued the notice';
COMMENT ON COLUMN appointment_notices.issued_at IS 'pd:none — when the notice was issued';

CREATE TABLE appointment_notice_lines (
    org_id             UUID    NOT NULL,
    notice_id          UUID    NOT NULL,
    lifecycle_event_id UUID    NOT NULL REFERENCES employee_lifecycle_events (id) ON DELETE RESTRICT,
    line_no            INTEGER NOT NULL
        CONSTRAINT appointment_notice_lines_no_check CHECK (line_no BETWEEN 1 AND 500),
    PRIMARY KEY (org_id, notice_id, line_no),
    -- A 발령 is announced on one notice only.
    CONSTRAINT appointment_notice_lines_event_once UNIQUE (org_id, lifecycle_event_id),
    FOREIGN KEY (org_id, notice_id) REFERENCES appointment_notices (org_id, id) ON DELETE RESTRICT
);

ALTER TABLE appointment_notice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_notice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON appointment_notice_lines
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_appointment_notice_lines_org_immutable BEFORE UPDATE ON appointment_notice_lines
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

GRANT SELECT, INSERT ON appointment_notice_lines TO console_rt;

COMMENT ON TABLE appointment_notice_lines IS 'BE-EMP-UI the lifecycle events one 발령 공고 announces, in printed order';
COMMENT ON COLUMN appointment_notice_lines.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN appointment_notice_lines.notice_id IS 'pd:none — the notice';
COMMENT ON COLUMN appointment_notice_lines.lifecycle_event_id IS 'pd:personal — the announced 발령 (names one employee); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN appointment_notice_lines.line_no IS 'pd:none — printed order, from 1';

-- ---------------------------------------------------------------------------
-- 3. Idempotency operation of the notice issue (0290's list plus one).
ALTER TABLE api_idempotency_keys DROP CONSTRAINT IF EXISTS api_idempotency_keys_operation_check;
ALTER TABLE api_idempotency_keys ADD CONSTRAINT api_idempotency_keys_operation_check
    CHECK (operation IN (
        'users.create', 'employee.lifecycle.create', 'hr.exit_case.create',
        'employee.lifecycle.bulk',
        'period_lock.lock', 'period_lock.unlock', 'period_lock.unlock_approve',
        'employee.correction.bulk',
        'appointment_notice.issue'
    ));

-- ---------------------------------------------------------------------------
-- 4. 이관 확인
CREATE TABLE import_reconcile_checks (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    run_id      UUID        NOT NULL,
    source_key  TEXT        NOT NULL
        CONSTRAINT import_reconcile_checks_key_shape CHECK (btrim(source_key) <> ''),
    state       TEXT        NOT NULL
        CONSTRAINT import_reconcile_checks_state_check CHECK (state IN ('CONFIRMED', 'NEEDS_CHECK')),
    note        TEXT        NULL
        CONSTRAINT import_reconcile_checks_note_shape CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
    version     INTEGER     NOT NULL DEFAULT 1
        CONSTRAINT import_reconcile_checks_version_check CHECK (version >= 1),
    checked_by  UUID        NOT NULL,
    checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, run_id, source_key),
    FOREIGN KEY (run_id, org_id) REFERENCES data_import_runs (id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (checked_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

ALTER TABLE import_reconcile_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_reconcile_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_reconcile_checks
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_import_reconcile_checks_org_immutable BEFORE UPDATE ON import_reconcile_checks
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

GRANT SELECT, INSERT ON import_reconcile_checks TO console_rt;
GRANT UPDATE (state, note, version, checked_by, checked_at) ON import_reconcile_checks TO console_rt;

COMMENT ON TABLE import_reconcile_checks IS 'BE-EMP-UI 이관 확인: the verification state of one applied import row';
COMMENT ON COLUMN import_reconcile_checks.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN import_reconcile_checks.run_id IS 'pd:none — the applied import run';
COMMENT ON COLUMN import_reconcile_checks.source_key IS 'pd:none — the run row (sheet + row key, data_import_rows.source_key)';
COMMENT ON COLUMN import_reconcile_checks.state IS 'pd:none — CONFIRMED (확인함) or NEEDS_CHECK (확인 필요)';
COMMENT ON COLUMN import_reconcile_checks.note IS 'pd:personal — the checker''s note about the row; may describe the person';
COMMENT ON COLUMN import_reconcile_checks.version IS 'pd:none — write pin; a stale write is refused';
COMMENT ON COLUMN import_reconcile_checks.checked_by IS 'pd:personal — who set the state';
COMMENT ON COLUMN import_reconcile_checks.checked_at IS 'pd:none — when the state was set';

CREATE TABLE import_signoffs (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    run_id      UUID        NOT NULL,
    signed_by   UUID        NOT NULL,
    signed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    total_rows  INTEGER     NOT NULL CONSTRAINT import_signoffs_rows_check CHECK (total_rows >= 0),
    confirmed   INTEGER     NOT NULL CONSTRAINT import_signoffs_confirmed_check CHECK (confirmed >= 0),
    needs_check INTEGER     NOT NULL CONSTRAINT import_signoffs_needs_check_check CHECK (needs_check >= 0),
    unchecked   INTEGER     NOT NULL CONSTRAINT import_signoffs_unchecked_check CHECK (unchecked >= 0),
    note        TEXT        NULL
        CONSTRAINT import_signoffs_note_shape CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
    PRIMARY KEY (org_id, run_id),
    CONSTRAINT import_signoffs_counts_add_up CHECK (confirmed + needs_check + unchecked = total_rows),
    FOREIGN KEY (run_id, org_id) REFERENCES data_import_runs (id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (signed_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

ALTER TABLE import_signoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_signoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_signoffs
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_import_signoffs_org_immutable BEFORE UPDATE ON import_signoffs
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

-- Signed once, never rewritten.
GRANT SELECT, INSERT ON import_signoffs TO console_rt;

COMMENT ON TABLE import_signoffs IS 'BE-EMP-UI 이관 확인 sign-off: an HR worker attests an applied import, with the counts attested over';
COMMENT ON COLUMN import_signoffs.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN import_signoffs.run_id IS 'pd:none — the applied import run';
COMMENT ON COLUMN import_signoffs.signed_by IS 'pd:personal — the HR worker who signed off';
COMMENT ON COLUMN import_signoffs.signed_at IS 'pd:none — when';
COMMENT ON COLUMN import_signoffs.total_rows IS 'pd:none — the run rows reconciled';
COMMENT ON COLUMN import_signoffs.confirmed IS 'pd:none — rows marked 확인함 at sign-off';
COMMENT ON COLUMN import_signoffs.needs_check IS 'pd:none — rows left 확인 필요 at sign-off';
COMMENT ON COLUMN import_signoffs.unchecked IS 'pd:none — rows not looked at by sign-off';
COMMENT ON COLUMN import_signoffs.note IS 'pd:personal — the signer''s note; may describe people';
