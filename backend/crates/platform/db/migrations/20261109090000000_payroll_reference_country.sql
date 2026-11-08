-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- migration-backfill: Identify the existing Korean citation register without changing its values or N-1 readers.
SET LOCAL lock_timeout = '2s';
ALTER TABLE payroll_statutory_rates ADD COLUMN country_code TEXT;
COMMENT ON COLUMN payroll_statutory_rates.country_code IS
    'pd:none — jurisdiction owning the citation; NULL means not classified';
UPDATE payroll_statutory_rates SET country_code='KR' WHERE country_code IS NULL;
