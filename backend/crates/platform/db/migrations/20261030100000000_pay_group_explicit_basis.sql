-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — required pay choices cannot be inferred for existing groups
-- Existing groups require an explicit owner decision; never infer these choices.
SET LOCAL lock_timeout = '2s';
ALTER TABLE pay_groups
    ADD COLUMN sensitive BOOLEAN NOT NULL,
    ADD COLUMN pay_basis_allowed TEXT[] NOT NULL CHECK (
        cardinality(pay_basis_allowed) BETWEEN 1 AND 2
        AND array_ndims(pay_basis_allowed) = 1 AND array_lower(pay_basis_allowed, 1) = 1
        AND array_position(pay_basis_allowed, NULL) IS NULL
        AND pay_basis_allowed <@ ARRAY['MONTHLY','HOURLY']::text[]
        AND (cardinality(pay_basis_allowed) = 1 OR pay_basis_allowed[1] <> pay_basis_allowed[2]));
COMMENT ON COLUMN pay_groups.sensitive IS 'pd:none — explicitly selected group sensitivity';
COMMENT ON COLUMN pay_groups.pay_basis_allowed IS 'pd:none — explicitly selected supported contract wage bases';
