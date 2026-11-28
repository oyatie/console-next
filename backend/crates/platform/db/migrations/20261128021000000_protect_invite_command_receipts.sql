-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Invitation secrets and grant details use the step-up protected domain receipt.
-- contract-of: 0328
-- migration-backfill: Clear prior generic invitation results; preserve command identity, history and the redacted domain receipt.
SET LOCAL lock_timeout = '2s';

-- Older API instances may still capture the initial response during rolling deployment.
CREATE FUNCTION omit_invite_command_result() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
    NEW.result := NULL;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION omit_invite_command_result() FROM PUBLIC, console_rt;
CREATE TRIGGER trg_command_invite_result BEFORE INSERT OR UPDATE OF result ON command_outcomes
    FOR EACH ROW WHEN (NEW.result IS NOT NULL AND NEW.command IN (
        'POST /api/v1/access/invites', 'POST /api/v1/access/invites [respond-async]'
    )) EXECUTE FUNCTION omit_invite_command_result();

-- The DDL lock excludes all concurrent writers until the guard is restored at commit.
ALTER TABLE command_outcomes DISABLE TRIGGER trg_command_outcome_immutable;
UPDATE command_outcomes SET result = NULL
 WHERE command IN ('POST /api/v1/access/invites', 'POST /api/v1/access/invites [respond-async]')
   AND result IS NOT NULL;
SET CONSTRAINTS trg_command_outcome_emit IMMEDIATE;
ALTER TABLE command_outcomes ENABLE TRIGGER trg_command_outcome_immutable;
