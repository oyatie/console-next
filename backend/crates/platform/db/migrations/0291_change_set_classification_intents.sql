-- MR-27: the change set grid goes beyond TRANSFER / PROMOTE. A draft may now
-- hold the MR-24/25 dated changes too: APPOINT (직책 · 직무 · 직군) and
-- EMPLOYMENT_TYPE_CHANGE (고용형태 전환), and a PROMOTE line may carry the
-- 직급. Each line keeps its own values, so a grid drafts a different 직책 or
-- 전환 per person and commits them as one lifecycle batch (BW-38). Numbered
-- head+1 of hard/life/mr27; INTEG renumbers it at the batch merge.
--
-- The new line columns mirror employee_lifecycle_events' to_ side (0266); the
-- commit runs every line through the single-event rules, so the per-kind
-- field rules live there, not here. No data change; no seeds.
SET LOCAL lock_timeout = '2s';

ALTER TABLE change_sets DROP CONSTRAINT change_sets_intent_check;
ALTER TABLE change_sets ADD CONSTRAINT change_sets_intent_check
    CHECK (intent IN ('TRANSFER', 'PROMOTE', 'APPOINT', 'EMPLOYMENT_TYPE_CHANGE'));
-- change_sets.intent keeps its 0263 classification (one marker per column).

ALTER TABLE change_set_lines
    ADD COLUMN to_grade_id UUID NULL,
    ADD COLUMN to_position_kind_id UUID NULL,
    ADD COLUMN vacate_position_kind BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN to_job_id UUID NULL,
    ADD COLUMN to_job TEXT NULL
        CONSTRAINT change_set_lines_job_shape CHECK (to_job IS NULL OR char_length(to_job) BETWEEN 1 AND 200),
    ADD COLUMN to_job_family_id UUID NULL,
    ADD COLUMN to_employment_type TEXT NULL
        CONSTRAINT change_set_lines_employment_type_check CHECK (to_employment_type IS NULL OR to_employment_type IN (
            'REGULAR', 'CONTRACT', 'PART_TIME', 'INTERN',
            'DAILY', 'EXECUTIVE', 'DISPATCHED_IN', 'OUTSOURCED_ON_SITE', 'FREELANCE')),
    ADD COLUMN contract_end_date DATE NULL,
    ADD CONSTRAINT change_set_lines_grade_fk
        FOREIGN KEY (org_id, to_grade_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT change_set_lines_position_kind_fk
        FOREIGN KEY (org_id, to_position_kind_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT change_set_lines_job_fk
        FOREIGN KEY (org_id, to_job_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT change_set_lines_job_family_fk
        FOREIGN KEY (org_id, to_job_family_id) REFERENCES job_titles (org_id, id) ON DELETE RESTRICT;

-- Column grants add to 0263's list: a redraft rewrites the new values too.
GRANT UPDATE (to_grade_id, to_position_kind_id, vacate_position_kind, to_job_id, to_job,
              to_job_family_id, to_employment_type, contract_end_date) ON change_set_lines TO console_rt;

COMMENT ON COLUMN change_set_lines.to_grade_id IS 'pd:personal — PROMOTE target 직급 (catalog GRADE); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.to_position_kind_id IS 'pd:personal — APPOINT target 직책 (catalog POSITION); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.vacate_position_kind IS 'pd:personal — APPOINT 보직 해제 (no 직책 after); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.to_job_id IS 'pd:personal — APPOINT target 직무 (catalog JOB); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.to_job IS 'pd:personal — APPOINT target 종사 업무 as text (no catalog id); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.to_job_family_id IS 'pd:personal — APPOINT target 직군 (catalog JOB_FAMILY); 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.to_employment_type IS 'pd:personal — EMPLOYMENT_TYPE_CHANGE target 고용형태; 개보법 제2조제1호나목 결합 식별';
COMMENT ON COLUMN change_set_lines.contract_end_date IS 'pd:personal — EMPLOYMENT_TYPE_CHANGE to CONTRACT: the new contract end; 개보법 제2조제1호나목 결합 식별';
