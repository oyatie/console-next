-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

COMMENT ON COLUMN payroll_line_calculations.created_at IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.deductions IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.gross_won IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.id IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.line_id IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.net_won IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.org_id IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.payable IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.run_id IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.tax_table_version IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.total_deductions_won IS 'pd:personal — employee-linked payroll calculation';
COMMENT ON COLUMN payroll_line_calculations.version IS 'pd:personal — employee-linked payroll calculation';
