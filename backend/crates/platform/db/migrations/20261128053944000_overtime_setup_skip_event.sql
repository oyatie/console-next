-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Replace the event-kind constraint, preserving all earlier kinds and admitting the overtime skip.
-- contract-of: 0350
-- Allow the existing optional setup choice. Earlier readers filter by their own event kinds.
SET LOCAL lock_timeout = '2s';

ALTER TABLE tenant_phase_events DROP CONSTRAINT tenant_phase_events_kind_check;
ALTER TABLE tenant_phase_events ADD CONSTRAINT tenant_phase_events_kind_check CHECK (kind IN (
    'SETUP_OPENED', 'BACKFILLED', 'GO_LIVE', 'TERMS_ACCEPTED',
    'ORG_STEP_SKIPPED', 'EMPLOYEES_STEP_DEFERRED', 'ROLES_STEP_SKIPPED', 'OVERTIME_STEP_SKIPPED'
)) NOT VALID;
ALTER TABLE tenant_phase_events VALIDATE CONSTRAINT tenant_phase_events_kind_check;
