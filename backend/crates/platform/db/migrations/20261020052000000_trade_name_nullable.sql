-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Single-source SS-001: 법인명/상호 has one stored source: legal_entity_revisions.name.
-- Expand step: business_registration_revisions.trade_name is nullable and no longer
-- stores a derived copy of 법인명 for corporations. Individual registrations retain 상호.
SET LOCAL lock_timeout = '2s';

ALTER TABLE business_registration_revisions
    ALTER COLUMN trade_name DROP NOT NULL;

COMMENT ON COLUMN business_registration_revisions.trade_name IS 'pd:none — deprecated shadow of entity name; NULL for corporations, kept only for individual registrations (SS-001)';
