-- SPDX-License-Identifier: LicenseRef-Proprietary
SET LOCAL lock_timeout = '2s';
ALTER TABLE employee_exit_cases ADD COLUMN notice_service_start DATE;
COMMENT ON COLUMN employee_exit_cases.notice_service_start IS 'pd:personal — continuous-service basis preserved before rehire; historical notice-pay reads do not use a new hire date';
UPDATE employee_exit_cases c SET notice_service_start=e.hire_on FROM employees e
WHERE e.org_id=c.org_id AND e.id=c.employee_id AND e.hire_on <= c.effective_exit_date;
