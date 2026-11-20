-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Enforce org_id immutability on data_import_row_identities before granting runtime envelope updates.
SET LOCAL lock_timeout = '2s';

-- Table-specific function because the shared 0031 function references OLD.id,
-- whereas data_import_row_identities uses composite PK (org_id, run_id, source_key).
CREATE OR REPLACE FUNCTION data_import_row_identities_org_id_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
        RAISE EXCEPTION
            'org_id is immutable: cannot change tenant from % to % on data_import_row_identities',
            OLD.org_id, NEW.org_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_data_import_row_identities_org_immutable
    BEFORE UPDATE ON data_import_row_identities
    FOR EACH ROW EXECUTE FUNCTION data_import_row_identities_org_id_immutable();
