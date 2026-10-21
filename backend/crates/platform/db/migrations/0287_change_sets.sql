-- BW-38: the server change set behind the grid and bulk 발령 edits (the H1+
-- ship condition, h1plus-amendments §6D: "one commit per intent; persistent
-- 「저장 안 됨 · n건」; the server change set is a ship condition").
-- Numbered head+1 of hard/life/bw38 (BW-11's 0259); INTEG renumbers at the
-- batch merge.
--
-- 1. change_sets: one draft per (owner, intent). At most one OPEN set per
--    owner and intent (partial unique index), so 「+ 발령안」 reopens the
--    owner's own draft and never someone else's. A set is committed (all
--    lines as one lifecycle batch, all or nothing) or discarded; it is never
--    deleted, so a committed set keeps naming its batch.
-- 2. change_set_lines: one line per employee per set, carrying the per-person
--    transition and the version pin (employees.head_version, 0256) the line
--    was drafted against. A stale pin refuses the whole commit (409).
-- The intents are the kinds the bulk lifecycle endpoint takes (TRANSFER,
-- PROMOTE); a later migration grows the CHECK.
SET LOCAL lock_timeout = '2s';

-- ---------------------------------------------------------------------------
-- 1. change_sets
CREATE TABLE change_sets (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id          UUID        NOT NULL DEFAULT gen_random_uuid(),
    intent      TEXT        NOT NULL
        CONSTRAINT change_sets_intent_check CHECK (intent IN ('TRANSFER', 'PROMOTE')),
    state       TEXT        NOT NULL DEFAULT 'OPEN'
        CONSTRAINT change_sets_state_check CHECK (state IN ('OPEN', 'COMMITTED', 'DISCARDED')),
    -- The lifecycle batch a commit recorded (BW-11 rescinds it as one).
    batch_id    UUID        NULL,
    created_by  UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at   TIMESTAMPTZ NULL,
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT change_sets_closed_shape CHECK (
        (state = 'OPEN' AND closed_at IS NULL AND batch_id IS NULL)
        OR (state = 'COMMITTED' AND closed_at IS NOT NULL AND batch_id IS NOT NULL)
        OR (state = 'DISCARDED' AND closed_at IS NOT NULL AND batch_id IS NULL)
    )
);
CREATE UNIQUE INDEX change_sets_one_open_idx
    ON change_sets (org_id, created_by, intent) WHERE state = 'OPEN';

ALTER TABLE change_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON change_sets
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_change_sets_org_immutable BEFORE UPDATE ON change_sets
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

GRANT SELECT, INSERT ON change_sets TO console_rt;
GRANT UPDATE (state, batch_id, closed_at) ON change_sets TO console_rt;

COMMENT ON TABLE change_sets IS 'BW-38 server change set: one draft of lifecycle lines per owner and intent, committed as one batch or discarded';
COMMENT ON COLUMN change_sets.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN change_sets.id IS 'pd:none — change set id';
COMMENT ON COLUMN change_sets.intent IS 'pd:none — the lifecycle kind every line records (TRANSFER, PROMOTE)';
COMMENT ON COLUMN change_sets.state IS 'pd:none — OPEN (drafting), COMMITTED (recorded as batch_id), DISCARDED';
COMMENT ON COLUMN change_sets.batch_id IS 'pd:none — employee_lifecycle_events.batch_id the commit recorded';
COMMENT ON COLUMN change_sets.created_by IS 'pd:personal — the owner; only the owner reads, edits, commits or discards the set';
COMMENT ON COLUMN change_sets.created_at IS 'pd:none — when the draft was opened';
COMMENT ON COLUMN change_sets.closed_at IS 'pd:none — when the set was committed or discarded';

-- ---------------------------------------------------------------------------
-- 2. change_set_lines
CREATE TABLE change_set_lines (
    org_id                UUID        NOT NULL,
    id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
    change_set_id         UUID        NOT NULL,
    employee_id           UUID        NOT NULL,
    expected_head_version INTEGER     NOT NULL
        CONSTRAINT change_set_lines_version_check CHECK (expected_head_version >= 0),
    effective_date        DATE        NOT NULL,
    to_org_unit_id        UUID        NULL,
    to_job_title_id       UUID        NULL,
    to_position           TEXT        NULL
        CONSTRAINT change_set_lines_position_shape CHECK (to_position IS NULL OR char_length(to_position) BETWEEN 1 AND 200),
    reason_code           TEXT        NULL
        CONSTRAINT change_set_lines_reason_shape CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 100),
    -- The same ceiling as employee_lifecycle_events_comment_max (0252), so a
    -- line that saved never fails the commit on length.
    comment               TEXT        NOT NULL
        CONSTRAINT change_set_lines_comment_max CHECK (char_length(comment) <= 1000),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    CONSTRAINT change_set_lines_one_per_employee UNIQUE (change_set_id, employee_id),
    FOREIGN KEY (org_id, change_set_id) REFERENCES change_sets (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (employee_id, org_id) REFERENCES employees (id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, to_org_unit_id) REFERENCES org_units (org_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (org_id, to_job_title_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT
);
-- "Another draft on this person" (the tray's contention count).
CREATE INDEX change_set_lines_org_employee_idx ON change_set_lines (org_id, employee_id);

ALTER TABLE change_set_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_set_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON change_set_lines
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_change_set_lines_org_immutable BEFORE UPDATE ON change_set_lines
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

-- DELETE: removing a line from an OPEN draft (the writer checks OPEN under
-- the set's row lock).
GRANT SELECT, INSERT, DELETE ON change_set_lines TO console_rt;
GRANT UPDATE (expected_head_version, effective_date, to_org_unit_id, to_job_title_id,
              to_position, reason_code, comment, updated_at) ON change_set_lines TO console_rt;

COMMENT ON TABLE change_set_lines IS 'BW-38 one drafted lifecycle line per employee per change set, pinned to the head version it was drafted against';
COMMENT ON COLUMN change_set_lines.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN change_set_lines.id IS 'pd:none — line id';
COMMENT ON COLUMN change_set_lines.change_set_id IS 'pd:none — the owning change set';
COMMENT ON COLUMN change_set_lines.employee_id IS 'pd:personal — the employee the line moves; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.expected_head_version IS 'pd:none — employees.head_version the line was drafted against (BW-11 pin)';
COMMENT ON COLUMN change_set_lines.effective_date IS 'pd:personal — the drafted 발령 date; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.to_org_unit_id IS 'pd:personal — TRANSFER target unit; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.to_job_title_id IS 'pd:personal — PROMOTE target title (catalog id); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.to_position IS 'pd:personal — PROMOTE target position text; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.reason_code IS 'pd:none — BW-07 lifecycle_transfer / lifecycle_promote code';
COMMENT ON COLUMN change_set_lines.comment IS 'pd:personal — the line note recorded on the event; free text about the person';
COMMENT ON COLUMN change_set_lines.created_at IS 'pd:none — when the line was drafted';
COMMENT ON COLUMN change_set_lines.updated_at IS 'pd:none — when the line was last redrafted';
