-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_personal_facts
    ADD COLUMN bank_account_registered BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN employee_personal_facts.bank_account_registered IS 'pd:personal — boolean-only attestation that a payroll deposit account exists externally (zero raw account or bank numbers stored)';

GRANT UPDATE (bank_account_registered, updated_at)
    ON public.employee_personal_facts TO console_rt;
