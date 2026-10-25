-- SPDX-License-Identifier: LicenseRef-Proprietary
SET LOCAL lock_timeout = '2s';
ALTER TABLE statutory_rules ADD COLUMN protection_leave_types TEXT[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN statutory_rules.protection_leave_types IS 'pd:none — leave reference codes protected by this statutory row';
UPDATE statutory_rules SET protection_leave_types=ARRAY['WORK_INJURY','MATERNITY'] WHERE code='DISMISSAL_PROTECTION_TAIL_DAYS';
UPDATE statutory_rules SET protection_leave_types=ARRAY['CHILDCARE'] WHERE code='CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS';
