-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Correct stored phone numbers while retaining account uniqueness and revision history.
-- migration-backfill: Correct current contacts in place or by appending revisions. An application rollback retains corrected values.
-- contract-of: 0172
SET LOCAL lock_timeout = '2s';
-- Project and append from a stable snapshot while application writers finish their transactions.
LOCK TABLE users, person_revisions, employee_employment_profiles, employee_emergency_contacts,
    data_import_row_phones, legal_entity_revisions, workplace_revisions IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION console_is_legacy_phone(phone text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE RETURN phone ~ '^[+]82(0|82)';

CREATE FUNCTION pg_temp.correct_stored_phone(phone text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE WHEN console_is_legacy_phone(phone) AND subscriber ~ '^[1-9][0-9]{5,12}$'
        THEN '+82' || subscriber ELSE phone END
    FROM (SELECT regexp_replace(substr(phone, 4), '^(0|82)+', '') AS subscriber) parsed
$$;

DO $$
DECLARE
    tenant uuid;
    pending record;
    person record;
    entity legal_entity_revisions%ROWTYPE;
    workplace workplace_revisions%ROWTYPE;
    source_id uuid;
    changes jsonb;
BEGIN
    -- Count all owners before updating, including canonical owners in other tenants.
    WITH candidates AS (
        SELECT id, phone, pg_temp.correct_stored_phone(phone) AS target FROM users WHERE phone LIKE '+82%'
    ), owners AS (
        SELECT *, count(*) OVER (PARTITION BY target) AS owner_count FROM candidates
    )
    UPDATE users u SET phone = o.target FROM owners o
        WHERE u.id = o.id AND o.owner_count = 1 AND o.phone <> o.target;

    FOR tenant IN SELECT id FROM organizations LOOP
        FOR person IN
            SELECT * FROM (SELECT DISTINCT ON (person_id) person_id, attributes->>'phone' AS phone
                FROM person_revisions WHERE org_id = tenant ORDER BY person_id, version DESC) current_facts
            WHERE phone IS DISTINCT FROM pg_temp.correct_stored_phone(phone)
        LOOP
            PERFORM console_revise_person_facts(tenant, person.person_id,
                jsonb_build_object('phone', pg_temp.correct_stored_phone(person.phone)), NULL);
        END LOOP;
        -- Bound employees already received their projection from the new person revision.
        UPDATE employee_employment_profiles SET phone_e164 = pg_temp.correct_stored_phone(phone_e164)
            WHERE org_id = tenant AND phone_e164 IS DISTINCT FROM pg_temp.correct_stored_phone(phone_e164);
        UPDATE employee_emergency_contacts SET phone_e164 = pg_temp.correct_stored_phone(phone_e164)
            WHERE org_id = tenant AND phone_e164 IS DISTINCT FROM pg_temp.correct_stored_phone(phone_e164);
        UPDATE data_import_row_phones SET phone_e164 = pg_temp.correct_stored_phone(phone_e164)
            WHERE org_id = tenant AND phone_e164 IS DISTINCT FROM pg_temp.correct_stored_phone(phone_e164);

        -- Readers select both by effective date and by latest version. Replay later winners in their
        -- original version order, including clean successors, so an old correction cannot become the head.
        FOR entity IN
            WITH winners AS (
                SELECT DISTINCT ON (legal_entity_id, effective_from) r.*
                FROM legal_entity_revisions r WHERE org_id = tenant ORDER BY legal_entity_id, effective_from, version DESC
            ), first_change AS (
                SELECT legal_entity_id, min(version) AS first_version FROM winners
                WHERE main_phone IS DISTINCT FROM pg_temp.correct_stored_phone(main_phone)
                GROUP BY legal_entity_id
            )
            SELECT w.* FROM winners w JOIN first_change c USING (legal_entity_id)
            WHERE w.version >= c.first_version ORDER BY w.legal_entity_id, w.version
        LOOP
            source_id := entity.id;
            entity.id := gen_random_uuid();
            entity.command_id := gen_random_uuid();
            SELECT max(version) + 1 INTO entity.version FROM legal_entity_revisions
                WHERE org_id = tenant AND legal_entity_id = entity.legal_entity_id;
            entity.main_phone := pg_temp.correct_stored_phone(entity.main_phone);
            entity.change_mode := 'MIGRATION';
            entity.actor_id := NULL;
            entity.created_at := now();
            entity.payload_digest := sha256(convert_to(jsonb_build_object('main_phone', entity.main_phone)::text, 'UTF8'));
            INSERT INTO legal_entity_revisions SELECT entity.*;
            INSERT INTO legal_entity_representatives (org_id, revision_id, seq, name)
                SELECT org_id, entity.id, seq, name FROM legal_entity_representatives
                WHERE org_id = tenant AND revision_id = source_id;
            INSERT INTO legal_entity_directors (org_id, revision_id, seq, role, name, appointed_on)
                SELECT org_id, entity.id, seq, role, name, appointed_on FROM legal_entity_directors
                WHERE org_id = tenant AND revision_id = source_id;
        END LOOP;

        FOR workplace IN
            WITH winners AS (
                SELECT DISTINCT ON (workplace_id, effective_from) r.*
                FROM workplace_revisions r WHERE org_id = tenant ORDER BY workplace_id, effective_from, version DESC
            ), first_change AS (
                SELECT workplace_id, min(version) AS first_version FROM winners
                WHERE phone IS DISTINCT FROM pg_temp.correct_stored_phone(phone)
                    OR fax IS DISTINCT FROM pg_temp.correct_stored_phone(fax)
                    OR mobile IS DISTINCT FROM pg_temp.correct_stored_phone(mobile)
                GROUP BY workplace_id
            )
            SELECT w.* FROM winners w JOIN first_change c USING (workplace_id)
            WHERE w.version >= c.first_version ORDER BY w.workplace_id, w.version
        LOOP
            workplace.id := gen_random_uuid();
            workplace.command_id := gen_random_uuid();
            SELECT max(version) + 1 INTO workplace.version FROM workplace_revisions
                WHERE org_id = tenant AND workplace_id = workplace.workplace_id;
            workplace.phone := pg_temp.correct_stored_phone(workplace.phone);
            workplace.fax := pg_temp.correct_stored_phone(workplace.fax);
            workplace.mobile := pg_temp.correct_stored_phone(workplace.mobile);
            workplace.change_mode := 'MIGRATION';
            workplace.actor_id := NULL;
            workplace.created_at := now();
            changes := jsonb_build_object('phone', workplace.phone, 'fax', workplace.fax, 'mobile', workplace.mobile);
            workplace.payload_digest := sha256(convert_to(changes::text, 'UTF8'));
            INSERT INTO workplace_revisions SELECT workplace.*;
        END LOOP;
    END LOOP;
    -- Only current facts and effective-date winners can need manual correction.
    -- A staging key includes arbitrary source text. Its digest identifies the row without logging that text.
    FOR pending IN
        SELECT 'users' AS relation, id::text AS row_id FROM users WHERE console_is_legacy_phone(phone)
        UNION ALL SELECT 'person_revisions', id::text FROM (
            SELECT DISTINCT ON (org_id, person_id) id, attributes FROM person_revisions
            ORDER BY org_id, person_id, version DESC
        ) p WHERE console_is_legacy_phone(attributes->>'phone')
        UNION ALL SELECT 'employee_employment_profiles', employee_id::text FROM employee_employment_profiles
            WHERE console_is_legacy_phone(phone_e164)
        UNION ALL SELECT 'employee_emergency_contacts', id::text FROM employee_emergency_contacts
            WHERE console_is_legacy_phone(phone_e164)
        UNION ALL SELECT 'data_import_row_phones', run_id::text || '/' || encode(sha256(convert_to(source_key,'UTF8')),'hex')
            FROM data_import_row_phones WHERE console_is_legacy_phone(phone_e164)
        UNION ALL SELECT 'legal_entity_revisions', id::text FROM (
            SELECT DISTINCT ON (org_id, legal_entity_id, effective_from) id, main_phone FROM legal_entity_revisions
            ORDER BY org_id, legal_entity_id, effective_from, version DESC
        ) e WHERE console_is_legacy_phone(main_phone)
        UNION ALL SELECT 'workplace_revisions', id::text FROM (
            SELECT DISTINCT ON (org_id, workplace_id, effective_from) id, phone, fax, mobile FROM workplace_revisions
            ORDER BY org_id, workplace_id, effective_from, version DESC
        ) w WHERE console_is_legacy_phone(phone) OR console_is_legacy_phone(fax) OR console_is_legacy_phone(mobile)
    LOOP
        RAISE WARNING 'Stored phone needs review in % row %', pending.relation, pending.row_id;
    END LOOP;
END $$;
DROP FUNCTION pg_temp.correct_stored_phone(text);

-- Migration precedes the canary. Reject legacy writes even when the previous image serves traffic again.
-- Column-specific triggers let unrelated updates proceed on a row awaiting manual correction.
CREATE FUNCTION reject_legacy_phone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Noncanonical Korean phone' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER reject_legacy_phone BEFORE INSERT OR UPDATE OF phone ON users
    FOR EACH ROW WHEN (console_is_legacy_phone(NEW.phone))
    EXECUTE FUNCTION reject_legacy_phone();
CREATE TRIGGER reject_legacy_phone BEFORE INSERT OR UPDATE OF attributes ON person_revisions
    FOR EACH ROW WHEN (console_is_legacy_phone(NEW.attributes->>'phone'))
    EXECUTE FUNCTION reject_legacy_phone();
CREATE TRIGGER reject_legacy_phone BEFORE INSERT OR UPDATE OF phone_e164 ON employee_employment_profiles
    FOR EACH ROW WHEN (console_is_legacy_phone(NEW.phone_e164))
    EXECUTE FUNCTION reject_legacy_phone();
CREATE TRIGGER reject_legacy_phone BEFORE INSERT OR UPDATE OF phone_e164 ON employee_emergency_contacts
    FOR EACH ROW WHEN (console_is_legacy_phone(NEW.phone_e164))
    EXECUTE FUNCTION reject_legacy_phone();
CREATE TRIGGER reject_legacy_phone BEFORE INSERT OR UPDATE OF phone_e164 ON data_import_row_phones
    FOR EACH ROW WHEN (console_is_legacy_phone(NEW.phone_e164))
    EXECUTE FUNCTION reject_legacy_phone();
CREATE TRIGGER reject_legacy_phone BEFORE INSERT OR UPDATE OF main_phone ON legal_entity_revisions
    FOR EACH ROW WHEN (console_is_legacy_phone(NEW.main_phone))
    EXECUTE FUNCTION reject_legacy_phone();
CREATE TRIGGER reject_legacy_phone BEFORE INSERT OR UPDATE OF phone, fax, mobile ON workplace_revisions
    FOR EACH ROW WHEN (console_is_legacy_phone(NEW.phone) OR console_is_legacy_phone(NEW.fax) OR console_is_legacy_phone(NEW.mobile))
    EXECUTE FUNCTION reject_legacy_phone();
