-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Optional display metadata; credential identity and SDK verification remain unchanged.
ALTER TABLE auth_webauthn_credentials ADD COLUMN label TEXT;
COMMENT ON COLUMN auth_webauthn_credentials.label IS 'pd:personal — account-selected passkey display name';
ALTER TABLE auth_webauthn_credentials ADD CONSTRAINT passkey_label_valid CHECK (
    label IS NULL OR (char_length(label) BETWEEN 1 AND 80 AND label = btrim(label)
                      AND label !~ '[[:cntrl:]]')
);

CREATE OR REPLACE FUNCTION public.auth_webauthn_guard_credential_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
    value jsonb;
    credential jsonb;
    fields constant text[] := ARRAY[
        'cred_id', 'cred', 'counter', 'transports', 'user_verified',
        'backup_eligible', 'backup_state', 'registration_policy',
        'extensions', 'attestation', 'attestation_format'
    ];
BEGIN
    -- Pure OLD/NEW validation: never acquire Account/security locks after a
    -- credential row lock. Only the display label is mutable alongside SDK state.
    IF (to_jsonb(NEW) - ARRAY['passkey_json', 'last_used_at', 'label']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['passkey_json', 'last_used_at', 'label']) THEN
        RAISE EXCEPTION 'credential identity is immutable' USING ERRCODE = '23514';
    END IF;

    FOREACH value IN ARRAY ARRAY[OLD.passkey_json, NEW.passkey_json] LOOP
        IF jsonb_typeof(value) IS DISTINCT FROM 'object'
           OR NOT value ? 'cred' OR value - 'cred' <> '{}'::jsonb
           OR jsonb_typeof(value->'cred') IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'unsupported stored passkey envelope' USING ERRCODE = '23514';
        END IF;
        credential := value->'cred';
        IF NOT credential ?& fields OR credential - fields <> '{}'::jsonb
           OR jsonb_typeof(credential->'cred_id') IS DISTINCT FROM 'string'
           OR jsonb_typeof(credential->'cred') IS DISTINCT FROM 'object'
           OR jsonb_typeof(credential->'transports') NOT IN ('array', 'null')
           OR jsonb_typeof(credential->'user_verified') IS DISTINCT FROM 'boolean'
           OR jsonb_typeof(credential->'registration_policy') IS DISTINCT FROM 'string'
           OR jsonb_typeof(credential->'extensions') IS DISTINCT FROM 'object'
           OR jsonb_typeof(credential->'attestation') IS DISTINCT FROM 'object'
           OR jsonb_typeof(credential->'attestation_format') IS DISTINCT FROM 'string'
           OR jsonb_typeof(credential->'counter') IS DISTINCT FROM 'number'
           OR (credential->>'counter') !~ '^(0|[1-9][0-9]{0,9})$'
           OR jsonb_typeof(credential->'backup_state') IS DISTINCT FROM 'boolean'
           OR jsonb_typeof(credential->'backup_eligible') IS DISTINCT FROM 'boolean' THEN
            RAISE EXCEPTION 'unsupported stored credential shape' USING ERRCODE = '23514';
        END IF;
        -- Shape checks precede casts. COSE/key/attestation verification stays
        -- with the standard SDK; SQL never substitutes for its crypto parser.
        IF (credential->>'counter')::bigint > 4294967295
           OR ((credential->>'backup_state')::boolean
               AND NOT (credential->>'backup_eligible')::boolean) THEN
            RAISE EXCEPTION 'invalid stored credential state' USING ERRCODE = '23514';
        END IF;
    END LOOP;

    IF ((OLD.passkey_json->'cred') - ARRAY['counter', 'backup_state', 'backup_eligible'])
       IS DISTINCT FROM
       ((NEW.passkey_json->'cred') - ARRAY['counter', 'backup_state', 'backup_eligible'])
       OR (NEW.passkey_json#>>'{cred,counter}')::bigint <
          (OLD.passkey_json#>>'{cred,counter}')::bigint
       OR ((OLD.passkey_json#>>'{cred,backup_eligible}')::boolean
           AND NOT (NEW.passkey_json#>>'{cred,backup_eligible}')::boolean) THEN
        RAISE EXCEPTION 'credential identity or monotonic state changed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.auth_webauthn_guard_credential_update()
FROM PUBLIC, console_rt, console_leave_cmd, console_ontology_cmd,
     console_platform_force_cmd, console_leave_definer, console_ontology_writer;

