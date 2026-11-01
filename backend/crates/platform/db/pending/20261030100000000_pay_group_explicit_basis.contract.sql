-- migration-class: contract
-- contract-of: 20261030100000000
-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-reason: require explicit choices after the expand release and owner completion
-- Move into migrations/ under a new version only after the previous release
-- writes both choices and owners have explicitly completed every NULL; never infer them.
SET LOCAL lock_timeout = '2s';
ALTER TABLE pay_groups
    ALTER COLUMN sensitive SET NOT NULL,
    ALTER COLUMN pay_basis_allowed SET NOT NULL;
