-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: contract — Correct stored phone numbers while retaining account uniqueness and revision history.
-- contract-of: 0172
SET LOCAL lock_timeout = '2s';
-- The non-superuser migration owner needs to enumerate tenants, including the platform organization.
ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY;
-- Project and append from a stable snapshot while application writers finish their transactions.
LOCK TABLE users, person_revisions, employee_employment_profiles, employee_emergency_contacts,
    data_import_row_phones, legal_entity_revisions, workplace_revisions IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION pg_temp.correct_stored_phone(phone text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
    national text := ltrim(substr(phone, 4), '0');
BEGIN
    IF phone !~ '^[+]820[0-9]{5,12}$' THEN RETURN phone; END IF;
    -- Both 00<international> and +82 00<national> could produce the same stored value.
    IF substr(phone, 5) ~ '^[1-9][0-9]{7,}$' OR length(national) < 6 THEN
        RAISE EXCEPTION 'Stored phone requires confirmation'
            USING HINT = 'Verify the original destination and correct the contact before rerunning the migration.';
    END IF;
    RETURN '+82' || national;
END $$;

DO $$
DECLARE
    tenant uuid;
    previous_org text := current_setting('app.current_org', true);
    person record;
    entity legal_entity_revisions%ROWTYPE;
    workplace workplace_revisions%ROWTYPE;
    source_id uuid;
    changes jsonb;
BEGIN
    FOR tenant IN SELECT id FROM organizations ORDER BY id LOOP
        PERFORM set_config('app.current_org', tenant::text, true);
        -- Account contacts have a global unique index. Any collision rolls back the migration.
        BEGIN
            UPDATE users SET phone = pg_temp.correct_stored_phone(phone)
                WHERE org_id = tenant AND phone IS DISTINCT FROM pg_temp.correct_stored_phone(phone);
        EXCEPTION WHEN unique_violation THEN
            RAISE EXCEPTION 'Account phone correction would duplicate another sign-in phone'
                USING ERRCODE = 'unique_violation', HINT = 'Verify account ownership before rerunning the migration.';
        END;

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
    PERFORM set_config('app.current_org', coalesce(previous_org, ''), true);
END $$;
DROP FUNCTION pg_temp.correct_stored_phone(text);
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
