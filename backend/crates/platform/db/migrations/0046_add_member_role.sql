-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Public-snapshot text of legacy migration 0046 (public-readiness O-4). The public export puts this file in place
-- of the private original, which stays unchanged in the private repository. Production names are replaced by
-- synthetic ones, in comments only; the SQL is unchanged.
-- Versions up to the baseline (0225) never run on a fresh install (app/src/schema_install.rs), and a database
-- that applied the original fails lineage validation against this text (its checksum differs).
-- Issue #38 — open self-service signup: add the lowest-privilege MEMBER role.
--
-- Anyone can now self-register (POST /api/v1/auth/signup): the new account lands
-- in the default (SAE) org with a single MEMBER role and sees almost nothing
-- until an admin elevates it (authz matrix: MEMBER is default-DENY everywhere
-- but Login). The `users.roles` column CHECK from 0002 hard-codes the original
-- 5-role set, so a MEMBER insert would violate it. Extend the allowed set to
-- include MEMBER.
--
-- 0002 declared the CHECK inline on the column, so Postgres auto-named it
-- `users_roles_check`. Drop that and re-add the same `roles <@ ARRAY[...]`
-- containment check with MEMBER appended, keeping every existing role valid.
--
-- console-gate: audited-table users
ALTER TABLE users
    DROP CONSTRAINT users_roles_check,
    ADD CONSTRAINT users_roles_check CHECK (
        roles <@ ARRAY['SUPER_ADMIN','ADMIN','MECHANIC','RECEPTIONIST','EXECUTIVE','MEMBER']
    );
