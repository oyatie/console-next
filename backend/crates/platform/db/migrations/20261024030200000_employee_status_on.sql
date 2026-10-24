-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand: normalize reads without rewriting statuses recorded by N-1 writers.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION entity_employment_status_on(
    on_date DATE, hire_date DATE, last_working_day DATE, status TEXT
) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
        WHEN status = 'VOIDED' THEN status
        WHEN hire_date > on_date THEN 'PRE_HIRE'
        WHEN entity_employed_on(on_date, hire_date, last_working_day, status)
            THEN CASE WHEN status IN ('PRE_HIRE', 'EXITED') THEN 'ACTIVE' ELSE status END
        WHEN last_working_day < on_date THEN 'EXITED'
        ELSE status
    END
$$;

REVOKE ALL ON FUNCTION entity_employment_status_on(DATE, DATE, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION entity_employment_status_on(DATE, DATE, DATE, TEXT) TO console_rt;
