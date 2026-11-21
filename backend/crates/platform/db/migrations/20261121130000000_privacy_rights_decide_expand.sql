-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

GRANT UPDATE (body) ON public.privacy_rights_requests TO console_rt;

CREATE OR REPLACE FUNCTION privacy_rights_requests_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    k TEXT;
    old_decisions JSONB;
    new_decisions JSONB;
    old_len INT;
    new_len INT;
BEGIN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id
       OR NEW.subject_employee_id IS DISTINCT FROM OLD.subject_employee_id THEN
        RAISE EXCEPTION 'privacy_rights_requests identity columns are immutable'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD.body->>'status' = 'DECIDED' THEN
        RAISE EXCEPTION 'privacy_rights_requests row is terminal after DECIDED'
            USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(NEW.body->>'status', '') NOT IN ('RECEIVED', 'DECIDED') THEN
        RAISE EXCEPTION 'privacy_rights_requests status must be RECEIVED or DECIDED'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.body->'id' IS DISTINCT FROM OLD.body->'id'
       OR NEW.body->'receipt_no' IS DISTINCT FROM OLD.body->'receipt_no'
       OR NEW.body->'receipt' IS DISTINCT FROM OLD.body->'receipt'
       OR NEW.body->'objection_of' IS DISTINCT FROM OLD.body->'objection_of'
       OR NEW.body->'detail' IS DISTINCT FROM OLD.body->'detail' THEN
        RAISE EXCEPTION 'privacy_rights_requests receipt fields are immutable'
            USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(OLD.body->'kinds') <> 'object'
       OR jsonb_typeof(NEW.body->'kinds') <> 'object'
       OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(OLD.body->'kinds') AS key)
          IS DISTINCT FROM
          (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.body->'kinds') AS key) THEN
        RAISE EXCEPTION 'privacy_rights_requests kinds map cannot add or remove keys'
            USING ERRCODE = 'P0001';
    END IF;
    FOR k IN SELECT jsonb_object_keys(OLD.body->'kinds') LOOP
        IF (NEW.body->'kinds'->k->'due') IS DISTINCT FROM (OLD.body->'kinds'->k->'due') THEN
            RAISE EXCEPTION 'privacy_rights_requests kind due is immutable'
                USING ERRCODE = 'P0001';
        END IF;
        old_decisions := COALESCE(OLD.body->'kinds'->k->'decisions', '[]'::jsonb);
        new_decisions := COALESCE(NEW.body->'kinds'->k->'decisions', '[]'::jsonb);
        IF jsonb_typeof(old_decisions) <> 'array' OR jsonb_typeof(new_decisions) <> 'array' THEN
            RAISE EXCEPTION 'privacy_rights_requests decisions must be an array'
                USING ERRCODE = '23514';
        END IF;
        old_len := jsonb_array_length(old_decisions);
        new_len := jsonb_array_length(new_decisions);
        IF new_len < old_len THEN
            RAISE EXCEPTION 'privacy_rights_requests decisions are append-only'
                USING ERRCODE = 'P0001';
        END IF;
        IF old_len > 0 THEN
            IF (SELECT array_agg(elem ORDER BY ord)
                  FROM jsonb_array_elements(old_decisions) WITH ORDINALITY AS t(elem, ord))
               IS DISTINCT FROM
               (SELECT array_agg(elem ORDER BY ord)
                  FROM jsonb_array_elements(new_decisions) WITH ORDINALITY AS t(elem, ord)
                 WHERE ord <= old_len) THEN
                RAISE EXCEPTION 'privacy_rights_requests prior decisions are immutable'
                    USING ERRCODE = 'P0001';
            END IF;
            IF new_len > old_len
               AND COALESCE(old_decisions->(old_len - 1)->'decision'->>'outcome', '') <> 'POSTPONED' THEN
                RAISE EXCEPTION 'privacy_rights_requests decided kind is terminal'
                    USING ERRCODE = 'P0001';
            END IF;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
