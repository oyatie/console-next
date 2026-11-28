-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

ALTER TABLE workflow_runs ADD COLUMN effective_definition JSONB;
COMMENT ON COLUMN workflow_runs.effective_definition IS
    'pd:none — server-validated execution graph pinned at creation when a run customizes its approval line';
-- All existing run transitions may still update their original columns. The graph can be
-- supplied at INSERT only, including for a running instance being resumed across an upgrade.
CREATE FUNCTION workflow_run_effective_definition_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.effective_definition IS DISTINCT FROM OLD.effective_definition THEN
        RAISE EXCEPTION 'a running workflow approval line is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_workflow_run_effective_definition_immutable
    BEFORE UPDATE OF effective_definition ON workflow_runs
    FOR EACH ROW EXECUTE FUNCTION workflow_run_effective_definition_immutable();
