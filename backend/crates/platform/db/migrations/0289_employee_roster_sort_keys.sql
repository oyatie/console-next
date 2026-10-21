-- PEOPLE-READS-2 (hr-polish A1; data-display-and-realtime §6.1): the roster's
-- server sort and keyset paging. Each sortable column gets an index
-- (org_id, sort key, id), the key written exactly as the list query orders by
-- it (a missing value sorts as ''), so a page is an index range scan.
-- Numbered head+1 of the lane's base (0260, hard/people-b/e-s3a); INTEG renumbers it.
SET LOCAL lock_timeout = '2s';

CREATE INDEX employees_org_sort_name_idx
    ON employees (org_id, name, id);
CREATE INDEX employees_org_sort_number_idx
    ON employees (org_id, (COALESCE(employee_number, '')), id);
CREATE INDEX employees_org_sort_hire_idx
    ON employees (org_id, (COALESCE(hire_date, '')), id);
CREATE INDEX employees_org_sort_unit_idx
    ON employees (org_id, (COALESCE(org_unit, '')), id);
