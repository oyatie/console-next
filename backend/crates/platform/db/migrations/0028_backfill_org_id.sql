-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Public-snapshot text of legacy migration 0028 (public-readiness O-4). The public export puts this file in place
-- of the private original, which stays unchanged in the private repository. Production names are replaced by
-- synthetic ones, in comments and in SQL values; the statements are the same.
-- Versions up to the baseline (0225) never run on a fresh install (app/src/schema_install.rs), and a database
-- that applied the original fails lineage validation against this text (its checksum differs).
-- Multi-tenant phase 1, step 3: seed tenant #1 and backfill every slice row.
--
-- All pre-existing data belongs to SAE Logistics (the only tenant before
-- multi-tenancy). Create that organization and stamp every slice row with its
-- id, leaving zero NULLs so 0029 can SET NOT NULL. The DO block captures the
-- freshly generated org id in a variable and reuses it across all updates.
--
-- Idempotent on the organization (ON CONFLICT on the unique slug); the UPDATEs
-- only touch rows whose org_id is still NULL, so re-running is a clean no-op.

-- SAE's org id is FIXED (not gen_random_uuid) so the application has a stable
-- compile-time constant for tenant #1 (console_kernel_core::OrgId::one()). Every
-- single-tenant write path arms `app.current_org` with this exact value until
-- the per-request tenant resolver lands; the runtime constant and the seeded
-- row must therefore agree byte-for-byte.
DO $$
DECLARE
    sae_id UUID := '00000000-0000-0000-0000-0000000000a1';
BEGIN
    INSERT INTO organizations (id, slug, name)
    VALUES (sae_id, 'sae', 'SAE Logistics')
    ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
    RETURNING id INTO sae_id;

    UPDATE regions            SET org_id = sae_id WHERE org_id IS NULL;
    UPDATE branches           SET org_id = sae_id WHERE org_id IS NULL;
    UPDATE users              SET org_id = sae_id WHERE org_id IS NULL;
    UPDATE registry_customers SET org_id = sae_id WHERE org_id IS NULL;
    UPDATE registry_sites     SET org_id = sae_id WHERE org_id IS NULL;
    UPDATE registry_equipment SET org_id = sae_id WHERE org_id IS NULL;
    UPDATE work_orders        SET org_id = sae_id WHERE org_id IS NULL;
END
$$;
