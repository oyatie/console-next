-- UX-R1 ENTITY (company-06, catalog company-07; decisions #21 dated facts):
-- 휴업 is recorded on a 사업자등록 or a 사업장 as a dated status revision
-- (status = SUSPENDED from status_since); 재개 is a later revision back to
-- CONTINUING. The 휴업 신고 names an expected end (휴업 기간, 부가세법
-- 시행령 §13①), so the revision keeps it beside the status: a plan, never a
-- clock (the trail items it opens are LIFECYCLE's). Numbered in this lane's
-- range, renumbered by INTEG from 0313–0315 to 0307–0309.
SET LOCAL lock_timeout = '2s';

ALTER TABLE business_registration_revisions
    ADD COLUMN status_until DATE NULL,
    ADD CONSTRAINT business_registration_revisions_status_until CHECK (
        status_until IS NULL OR (status = 'SUSPENDED' AND status_until >= status_since));
COMMENT ON COLUMN business_registration_revisions.status_until IS 'pd:none — 휴업 expected end (as reported); only with SUSPENDED, never before status_since';

ALTER TABLE workplace_revisions
    ADD COLUMN status_until DATE NULL,
    ADD CONSTRAINT workplace_revisions_status_until CHECK (
        status_until IS NULL OR (status = 'SUSPENDED' AND status_until >= status_since));
COMMENT ON COLUMN workplace_revisions.status_until IS 'pd:none — 휴업 expected end (as reported); only with SUSPENDED, never before status_since';
