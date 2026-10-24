-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand: stored exit dates remain 마지막 근무일 for N-1 writers.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION entity_today() RETURNS DATE
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT (now() AT TIME ZONE 'Asia/Seoul')::date
$$;

CREATE FUNCTION entity_retirement_on(last_working_day DATE) RETURNS DATE
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT last_working_day + 1
$$;

CREATE FUNCTION entity_employed_on(
    on_date DATE, hire_date DATE, last_working_day DATE, status TEXT
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT COALESCE(
        on_date IS NOT NULL
        AND status <> 'VOIDED'
        AND (hire_date IS NULL OR hire_date <= on_date)
        AND (last_working_day IS NULL OR on_date < entity_retirement_on(last_working_day))
        AND (status <> 'EXITED' OR last_working_day IS NOT NULL)
        AND (status <> 'PRE_HIRE' OR hire_date IS NOT NULL),
        false
    )
$$;

REVOKE ALL ON FUNCTION entity_today(), entity_retirement_on(DATE), entity_employed_on(DATE, DATE, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION entity_today(), entity_retirement_on(DATE), entity_employed_on(DATE, DATE, DATE, TEXT) TO console_rt;
