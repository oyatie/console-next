-- UX-R3 STRUCT (company-01/02, move-02, records-04): an exit ends the person's
-- 법인 · 사업장 assignment the day after the 마지막 근무일 (valid_to is
-- exclusive, as on employment_heads). The exit path writes that end from now
-- on (hr exits store -> entity employment_end); this backfills the people who
-- already left with an open row, so no 사업장 or 법인 keeps counting them and
-- a staffed 법인 can close. valid_to is set once from NULL (0259 guard), and a
-- row that starts after the exit is left alone (the period CHECK).
-- Numbered from this lane's range (0335-0339); INTEG renumbers. No seed rows.
SET LOCAL lock_timeout = '2s';

UPDATE employment_assignments a SET valid_to = e.exit_on + 1
FROM employees e
WHERE e.org_id = a.org_id AND e.id = a.employee_id
  AND e.employment_status = 'EXITED' AND e.exit_on IS NOT NULL
  AND a.superseded_at IS NULL AND a.valid_to IS NULL AND a.valid_from <= e.exit_on;
