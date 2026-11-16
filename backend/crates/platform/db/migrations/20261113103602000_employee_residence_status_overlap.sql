-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Guard only the new residence table; no existing records or N-1 writers change.
SET LOCAL lock_timeout = '2s';
-- btree_gist is not installed; serialize writers on the employee as employment_heads does.
CREATE FUNCTION employee_residence_status_no_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.valid_to <= NEW.valid_from THEN RETURN NEW; END IF;
    PERFORM 1 FROM employees WHERE org_id = NEW.org_id AND id = NEW.employee_id FOR UPDATE;
    IF EXISTS (
        SELECT 1 FROM employee_residence_statuses r
        WHERE r.org_id = NEW.org_id AND r.employee_id = NEW.employee_id AND r.id <> NEW.id
          AND daterange(r.valid_from, r.valid_to, '[)') && daterange(NEW.valid_from, NEW.valid_to, '[)')
    ) THEN
        RAISE EXCEPTION 'residence_status_overlap' USING ERRCODE = '23P01';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION employee_residence_status_no_overlap() FROM PUBLIC, console_rt;
CREATE TRIGGER employee_residence_status_no_overlap
    BEFORE INSERT OR UPDATE ON employee_residence_statuses
    FOR EACH ROW EXECUTE FUNCTION employee_residence_status_no_overlap();
