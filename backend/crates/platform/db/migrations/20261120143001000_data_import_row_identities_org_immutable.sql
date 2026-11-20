-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Enforce org_id immutability on data_import_row_identities before granting runtime envelope updates.
SET LOCAL lock_timeout = '2s';

CREATE TRIGGER trg_data_import_row_identities_org_immutable
    BEFORE UPDATE ON data_import_row_identities
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
