-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

ALTER TABLE payroll_draft_lines
    ADD COLUMN paid_holiday_days NUMERIC(10,2) NULL
        CHECK (paid_holiday_days IS NULL OR (paid_holiday_days >= 0));

ALTER TABLE payroll_draft_lines
    ADD COLUMN bank_account_registered BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN payroll_draft_lines.paid_holiday_days IS 'pd:personal — weekday paid public holiday count; combinable personal identifier';
COMMENT ON COLUMN payroll_draft_lines.bank_account_registered IS 'pd:personal — boolean flag indicating payroll deposit account registration (zero account numbers stored); combinable personal identifier';

ALTER TABLE payroll_line_calculations
    ADD COLUMN base_pay_won BIGINT NULL
        CHECK (base_pay_won IS NULL OR (base_pay_won >= 0));

ALTER TABLE payroll_line_calculations
    ADD COLUMN overtime_pay_won BIGINT NULL
        CHECK (overtime_pay_won IS NULL OR (overtime_pay_won >= 0));

ALTER TABLE payroll_line_calculations
    ADD COLUMN meal_allowance_won BIGINT NULL
        CHECK (meal_allowance_won IS NULL OR (meal_allowance_won >= 0));

ALTER TABLE payroll_line_calculations
    ADD COLUMN taxable_won BIGINT NULL
        CHECK (taxable_won IS NULL OR (taxable_won >= 0));

COMMENT ON COLUMN payroll_line_calculations.base_pay_won IS 'pd:personal — base pay in whole won; combinable personal identifier';
COMMENT ON COLUMN payroll_line_calculations.overtime_pay_won IS 'pd:personal — overtime allowance in whole won; combinable personal identifier';
COMMENT ON COLUMN payroll_line_calculations.meal_allowance_won IS 'pd:personal — non-taxable meal allowance in whole won; combinable personal identifier';
COMMENT ON COLUMN payroll_line_calculations.taxable_won IS 'pd:personal — taxable pay amount in whole won; combinable personal identifier';

GRANT INSERT (base_pay_won, overtime_pay_won, meal_allowance_won, taxable_won)
    ON public.payroll_line_calculations TO console_rt;
