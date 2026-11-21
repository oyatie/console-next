-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_personal_facts
    ADD COLUMN bank_account_registered BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN employee_personal_facts.bank_account_registered IS 'pd:personal — boolean-only attestation that a payroll deposit account exists externally (zero raw account or bank numbers stored)';

GRANT UPDATE (bank_account_registered, updated_at)
    ON public.employee_personal_facts TO console_rt;

-- console-gate: audited-table employee_bank_account_attestations
CREATE TABLE employee_bank_account_attestations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    employee_id UUID NOT NULL,
    old_value BOOLEAN NULL,
    new_value BOOLEAN NOT NULL,
    reason_code TEXT NOT NULL CHECK (char_length(btrim(reason_code)) BETWEEN 1 AND 100),
    note TEXT NULL CHECK (note IS NULL OR (btrim(note) <> '' AND char_length(note) <= 1000)),
    attested_by UUID NOT NULL,
    change_request_id UUID NULL,
    review_required BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (attested_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (change_request_id, org_id) REFERENCES change_requests(id, org_id) ON DELETE RESTRICT
);

CREATE INDEX employee_bank_account_attestations_org_emp_idx
    ON employee_bank_account_attestations (org_id, employee_id, created_at);

ALTER TABLE employee_bank_account_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_bank_account_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_bank_account_attestations
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

REVOKE ALL ON employee_bank_account_attestations FROM PUBLIC, console_rt;
GRANT SELECT, INSERT ON employee_bank_account_attestations TO console_rt;

COMMENT ON TABLE employee_bank_account_attestations IS 'Append-only ledger of employee payroll deposit account registration attestations (boolean-only)';
COMMENT ON COLUMN employee_bank_account_attestations.id IS 'pd:none — attestation record id';
COMMENT ON COLUMN employee_bank_account_attestations.org_id IS 'pd:none — tenant scope';
COMMENT ON COLUMN employee_bank_account_attestations.employee_id IS 'pd:personal — attested employee record';
COMMENT ON COLUMN employee_bank_account_attestations.old_value IS 'pd:personal — prior boolean bank_account_registered state';
COMMENT ON COLUMN employee_bank_account_attestations.new_value IS 'pd:personal — updated boolean bank_account_registered state';
COMMENT ON COLUMN employee_bank_account_attestations.reason_code IS 'pd:none — change reason code';
COMMENT ON COLUMN employee_bank_account_attestations.note IS 'pd:personal — optional decision or requester note';
COMMENT ON COLUMN employee_bank_account_attestations.attested_by IS 'pd:personal — user who recorded or applied the attestation';
COMMENT ON COLUMN employee_bank_account_attestations.change_request_id IS 'pd:none — originating change request if applied through one';
COMMENT ON COLUMN employee_bank_account_attestations.review_required IS 'pd:none — sole-holder post-review flag';
COMMENT ON COLUMN employee_bank_account_attestations.created_at IS 'pd:none — attestation timestamp';
