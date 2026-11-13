-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- Dated employee facts only; no runtime access until a Cedar-authorized API owns them.
-- Intervals are [valid_from, valid_to). No identification numbers or inferred eligibility.
SET LOCAL lock_timeout = '2s';
CREATE TABLE employee_residence_statuses (
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    code TEXT NOT NULL REFERENCES residence_status_codes(code) ON DELETE RESTRICT,
    valid_from DATE NOT NULL,
    valid_to DATE CONSTRAINT employee_residence_statuses_dates CHECK (valid_to > valid_from),
    PRIMARY KEY (org_id, id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX employee_residence_statuses_employee ON employee_residence_statuses(org_id, employee_id, valid_from);
ALTER TABLE employee_residence_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_residence_statuses FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_residence_statuses
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
REVOKE ALL ON employee_residence_statuses FROM PUBLIC, console_rt;
COMMENT ON TABLE employee_residence_statuses IS 'Dated residence facts; no work or insurance eligibility inferred; retained on employee removal';
COMMENT ON COLUMN employee_residence_statuses.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN employee_residence_statuses.id IS 'pd:none — row identity';
COMMENT ON COLUMN employee_residence_statuses.employee_id IS 'pd:personal — employee holding the status';
COMMENT ON COLUMN employee_residence_statuses.code IS 'pd:personal — residence status';
COMMENT ON COLUMN employee_residence_statuses.valid_from IS 'pd:personal — inclusive start of recorded status';
COMMENT ON COLUMN employee_residence_statuses.valid_to IS 'pd:personal — exclusive end of recorded status; NULL is open';
