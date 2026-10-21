-- Expand only; released migrations are immutable.
-- Planner statistics after a bulk employee import.
--
-- WHY: an import inserts hundreds to thousands of rows per apply into the tables the as-of
-- membership read joins. Until autovacuum's next analyze, reads planned in between use
-- statistics from before the load and can pick plans that run for tens of seconds (measured:
-- six org-structure / legal-entity reads and an import dry-run held every pooled connection
-- for the 30 s request budget, while the same statement on fresh statistics took 5 ms).
-- PostgreSQL's guidance for bulk loads is to ANALYZE afterwards; this is that step.
--
-- The runtime role (console_rt) does not own these tables and is not granted MAINTAIN (it
-- would also allow LOCK TABLE and REINDEX), so a definer function owned by the table owner
-- analyzes exactly this fixed set and nothing else. It reads and returns no row data.
CREATE FUNCTION public.hr_refresh_import_statistics() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
    ANALYZE public.employees, public.employee_employment_profiles,
        public.employment_source_bindings, public.employment_revisions,
        public.employment_assignments, public.employee_lifecycle_events;
END;
$$;

REVOKE ALL ON FUNCTION public.hr_refresh_import_statistics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_refresh_import_statistics() TO console_rt;
