-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Existing rows have no validated notice evidence. Keep them unconfirmed;
-- additive columns also let the previous writer insert truthful legacy rows.
SET LOCAL lock_timeout = '2s';

ALTER TABLE employee_emergency_contacts
    ADD COLUMN basis TEXT NULL,
    ADD COLUMN contact_notified BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT employee_emergency_contacts_notice_basis CHECK (
        basis IS NOT DISTINCT FROM
            CASE WHEN contact_notified THEN 'VITAL_INTEREST_PENDING_COUNSEL' END
    );

COMMENT ON COLUMN employee_emergency_contacts.basis IS
    'pd:none — server-validated processing basis, 검토 전; NULL = no evidence';
COMMENT ON COLUMN employee_emergency_contacts.contact_notified IS
    'pd:personal — employee confirmation that the contact was told; false = no validated evidence';
