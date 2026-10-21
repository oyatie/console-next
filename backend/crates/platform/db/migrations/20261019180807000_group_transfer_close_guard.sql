-- Expand only: the previous release may still advance a close job after
-- skipping a GROUP_TRANSFER line, so the invariant belongs in the database.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION public.guard_workplace_close_group_transfers_done() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.workplace_close_lines AS line
        WHERE line.org_id = NEW.org_id
          AND line.job_id = NEW.id
          AND line.action = 'GROUP_TRANSFER'
          AND NOT line.done
    ) THEN
        RAISE EXCEPTION 'workplace close has an incomplete group-transfer line'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'workplace_close_jobs_group_transfer_done';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workplace_close_jobs_group_transfer_done
    BEFORE UPDATE OF state ON public.workplace_close_jobs
    FOR EACH ROW
    WHEN (NEW.state = 'APPLIED')
    EXECUTE FUNCTION public.guard_workplace_close_group_transfers_done();
