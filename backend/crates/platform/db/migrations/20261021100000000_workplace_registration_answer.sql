-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Migration: workplace_registration_answer
-- Support workplace registration optionality (AD-ENT02 #46):
-- 1. 국세청 사업자등록: 등록함 / 등록 대상 아님 (with statutory reason) / 아직 모름
-- 2. Abstract workplaces (no address, not registered)

ALTER TABLE workplaces
    ADD COLUMN not_registered_reason_code TEXT NULL,
    ADD COLUMN not_registered_reason_label TEXT NULL,
    ADD COLUMN not_registered_reason_version TEXT NULL,
    ADD COLUMN is_abstract BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE workplaces
    ADD CONSTRAINT workplaces_registration_or_reason CHECK (registration_id IS NULL OR not_registered_reason_code IS NULL),
    ADD CONSTRAINT workplaces_not_registered_reason_shape CHECK (
        (not_registered_reason_code IS NULL) = (not_registered_reason_label IS NULL)
        AND (not_registered_reason_code IS NULL) = (not_registered_reason_version IS NULL)
    ),
    ADD CONSTRAINT workplaces_abstract_no_registration CHECK (NOT is_abstract OR registration_id IS NULL);

COMMENT ON COLUMN workplaces.not_registered_reason_code IS 'pd:none — statutory reason code why workplace is not registered';
COMMENT ON COLUMN workplaces.not_registered_reason_label IS 'pd:none — label of statutory reason why workplace is not registered';
COMMENT ON COLUMN workplaces.not_registered_reason_version IS 'pd:none — refdata list version of statutory reason';
COMMENT ON COLUMN workplaces.is_abstract IS 'pd:none — true if workplace is abstract (has no address and no registration)';

ALTER TABLE workplace_revisions
    ADD COLUMN not_registered_reason_code TEXT NULL,
    ADD COLUMN not_registered_reason_label TEXT NULL,
    ADD COLUMN not_registered_reason_version TEXT NULL,
    ADD COLUMN is_abstract BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE workplace_revisions
    DROP CONSTRAINT workplace_revisions_complete,
    ADD CONSTRAINT workplace_revisions_complete CHECK (
        change_mode = 'MIGRATION' OR ((is_abstract OR address_id IS NOT NULL) AND opened_on IS NOT NULL)
    ),
    ADD CONSTRAINT workplace_revisions_abstract_no_address CHECK (
        NOT is_abstract OR (address_id IS NULL AND NOT same_address_as_registration)
    ),
    ADD CONSTRAINT workplace_revisions_reason_shape CHECK (
        (not_registered_reason_code IS NULL) = (not_registered_reason_label IS NULL)
        AND (not_registered_reason_code IS NULL) = (not_registered_reason_version IS NULL)
    );

COMMENT ON COLUMN workplace_revisions.not_registered_reason_code IS 'pd:none — statutory reason code why workplace is not registered';
COMMENT ON COLUMN workplace_revisions.not_registered_reason_label IS 'pd:none — label of statutory reason why workplace is not registered';
COMMENT ON COLUMN workplace_revisions.not_registered_reason_version IS 'pd:none — refdata list version of statutory reason';
COMMENT ON COLUMN workplace_revisions.is_abstract IS 'pd:none — true if workplace is abstract (has no address and no registration)';

ALTER TABLE workplace_registration_changes
    ADD COLUMN from_not_registered_reason_code TEXT NULL,
    ADD COLUMN to_not_registered_reason_code TEXT NULL;

ALTER TABLE workplace_registration_changes
    DROP CONSTRAINT workplace_registration_changes_changed,
    ADD CONSTRAINT workplace_registration_changes_changed CHECK (
        (from_registration_id, from_sub_serial, from_not_registered_reason_code) IS DISTINCT FROM (to_registration_id, to_sub_serial, to_not_registered_reason_code)
    );

COMMENT ON COLUMN workplace_registration_changes.from_not_registered_reason_code IS 'pd:none — statutory not registered reason before';
COMMENT ON COLUMN workplace_registration_changes.to_not_registered_reason_code IS 'pd:none — statutory not registered reason after';
