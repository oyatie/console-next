-- PERF-BE (decisions #28; capacity report CAP-01): the roster reads at
-- 30,000 rows. Numbered after this lane's 0316 (INTEG renumbered 0307 -> 0317).
--
-- 1. The roster's 「미적용 발령」 count and filter read the employees with an
--    APPLY_FAILED action as one set (read_from.rs FAILED_SET_JOIN) instead of
--    probing every employee's events; failed actions are rare, so a partial
--    index keeps that read to the failed rows.
-- 2. The roster's offset order (company, name, source sheet/row: the paging
--    the web still uses until it moves to keyset, PF-1) as one index, so a
--    page reads offset + limit rows in order instead of sorting the tenant;
--    0086's index on the same columns is partial (leave balances only).
SET LOCAL lock_timeout = '2s';

CREATE INDEX employee_lifecycle_events_apply_failed_idx
    ON employee_lifecycle_events (org_id, employee_id)
    WHERE state = 'APPLY_FAILED';

CREATE INDEX employees_org_roster_order_idx
    ON employees (org_id, company, name, source_sheet, source_row);
