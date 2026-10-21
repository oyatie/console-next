-- The routing definer needs placement IDs and dates, never workplace records.
SET LOCAL lock_timeout = '2s';
REVOKE SELECT ON employment_assignments, workplaces FROM console_leave_definer;
GRANT SELECT (org_id, employee_id, workplace_id, superseded_at, valid_from, valid_to)
    ON employment_assignments TO console_leave_definer;
GRANT SELECT (org_id, id, default_branch_id) ON workplaces TO console_leave_definer;
