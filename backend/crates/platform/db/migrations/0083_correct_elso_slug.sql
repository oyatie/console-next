-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Public-snapshot text of legacy migration 0083 (public-readiness O-4). The public export puts this file in place
-- of the private original, which stays unchanged in the private repository. Production names are replaced by
-- synthetic ones, in comments and in SQL values; the statements are the same.
-- Versions up to the baseline (0225) never run on a fresh install (app/src/schema_install.rs), and a database
-- that applied the original fails lineage validation against this text (its checksum differs).
-- Correct the legacy Xorin tenant slug. The canonical slug is `orin`, not `xorin`.
-- Guard against environments where `orin` was already corrected manually.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM organizations
        WHERE slug = 'xorin'
          AND name ILIKE '%오린%'
    ) AND NOT EXISTS (
        SELECT 1
        FROM organizations
        WHERE slug = 'orin'
    ) THEN
        UPDATE organizations
        SET slug = 'orin',
            updated_at = now()
        WHERE slug = 'xorin'
          AND name ILIKE '%오린%';
    END IF;
END $$;
