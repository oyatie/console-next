-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Forget "not imported" for header words that had no field to map to.
-- contract-of: 0296
-- migration-backfill: Removes mapping-memory rows only; no business record changes. Application rollback keeps them removed.
SET LOCAL lock_timeout = '2s';

-- Days and hours worked are import fields from this release. A tenant that
-- edited a sheet's columns before it had every unmapped label remembered as
-- "not imported", these words included, while no field could take them. That
-- remembered answer outranks a suggestion, so it would keep these columns
-- unmapped and the payroll roster, which now reads only mapped values, would
-- lose their days and hours without a word. It is forgotten for exactly the
-- words the roster used to read; an operator who does not want one imported
-- says so again on the next file.
DO $$
BEGIN
    DELETE FROM import_column_memory
     WHERE target IS NULL
       AND header_key IN ('근무일수', '근무일', '근무시간', '기본시간', '기본근무',
                          '연장시간', '특근연장시간', '특근연장', '심야시간', '특근시간');
END $$;
