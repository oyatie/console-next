-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand: retain the immutable legacy history and receipts. Legal facts are
-- copied only where there is no entity; an existing entity always wins.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION migrate_company_legal_facts() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public SET row_security = off AS $$
DECLARE
    source RECORD;
    entity_id UUID;
    registration_id UUID;
    digits TEXT;
    snapshot JSONB;
BEGIN
    FOR source IN
        SELECT DISTINCT ON (org_id) * FROM company_revisions
        WHERE attributes ? 'legal_name' ORDER BY org_id, version DESC
    LOOP
        -- Never guess which of several entities a tenant revision meant, or
        -- overwrite the canonical name with an older tenant copy (COSS).
        CONTINUE WHEN EXISTS (SELECT 1 FROM legal_entities WHERE org_id = source.org_id);
        IF jsonb_typeof(source.attributes->'legal_name') IS DISTINCT FROM 'string'
           OR char_length(source.attributes->>'legal_name') NOT BETWEEN 1 AND 200
           OR btrim(source.attributes->>'legal_name') = '' THEN
            RAISE EXCEPTION 'company legal name requires migration review: %', source.id;
        END IF;
        snapshot := jsonb_build_object('source', 'company_revisions',
            'source_revision_id', source.id, 'source_version', source.version);
        INSERT INTO legal_entities (org_id, needs_confirmation, created_change_mode)
        VALUES (source.org_id, true, 'MIGRATION') RETURNING id INTO entity_id;
        INSERT INTO legal_entity_revisions
            (org_id, legal_entity_id, version, command_id, effective_from, name,
             change_mode, reason_code, payload_digest, settings_snapshot)
        VALUES (source.org_id, entity_id, 1, source.command_id,
            COALESCE(entity_try_iso_date(source.attributes->>'effective_from'), (source.created_at AT TIME ZONE 'Asia/Seoul')::date),
            source.attributes->>'legal_name', 'MIGRATION', 'MIGRATION_COMPANY_FACTS',
            source.payload_digest, snapshot);
        digits := regexp_replace(COALESCE(source.attributes->>'reg_no', source.attributes->>'registration_number', ''), '[^0-9]', '', 'g');
        IF digits ~ '^[0-9]{10}$' AND digits <> '0000000000' THEN
            INSERT INTO business_registrations
                (org_id, legal_entity_id, brn, needs_confirmation, unverified_reason, created_change_mode)
            VALUES (source.org_id, entity_id, digits, true, 'NOT_CHECKED', 'MIGRATION')
            RETURNING id INTO registration_id;
            INSERT INTO business_registration_revisions
                (org_id, registration_id, version, command_id, effective_from, status,
                 change_mode, reason_code, payload_digest, settings_snapshot)
            VALUES (source.org_id, registration_id, 1, gen_random_uuid(),
                COALESCE(entity_try_iso_date(source.attributes->>'effective_from'), (source.created_at AT TIME ZONE 'Asia/Seoul')::date), 'CONTINUING',
                'MIGRATION', 'MIGRATION_COMPANY_FACTS', source.payload_digest, snapshot);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM legal_entity_revisions
            WHERE legal_entity_id = entity_id AND name = source.attributes->>'legal_name') THEN
            RAISE EXCEPTION 'company legal fact copy verification failed: %', source.id;
        END IF;
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION migrate_company_legal_facts() FROM PUBLIC, console_rt;
SELECT migrate_company_legal_facts();

-- N-1 keeps its existing schema and privileges during overlap. New binaries
-- refuse fresh company writes; replay this backfill after N-1 drains, before
-- contracting the legacy history. No constraint is tightened in this release.
