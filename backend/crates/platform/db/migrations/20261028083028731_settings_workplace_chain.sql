-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Expand only: no stored data or columns change; old tenant/legal-entity inserts still work.
SET LOCAL lock_timeout = '2s';
CREATE OR REPLACE FUNCTION tenant_setting_overrides_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    d          RECORD;
    new_ord    BIGINT;
    cur_value  JSONB;
    cur_ord    BIGINT;
    looser     BOOLEAN;
    chain      UUID[];
BEGIN
    SELECT * INTO d FROM setting_definition(NEW.key);
    IF d.kind IS NULL THEN
        RAISE EXCEPTION 'setting_unknown_key' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF d.governance <> 'tenant' THEN
        RAISE EXCEPTION 'setting_not_editable' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    new_ord := setting_ordinal(d.kind, d.codes, NEW.value);
    IF new_ord IS NULL THEN
        RAISE EXCEPTION 'setting_value_invalid' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF d.kind = 'int' AND (new_ord < d.min_value OR new_ord > d.max_value) THEN
        RAISE EXCEPTION 'setting_out_of_range' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF NEW.effective_from < now() THEN
        RAISE EXCEPTION 'setting_backdated' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF NEW.scope_entity_id IS NOT NULL THEN
        SELECT ARRAY[w.id, w.legal_entity_id] INTO chain FROM workplaces w
          JOIN legal_entities e ON e.org_id=w.org_id AND e.id=w.legal_entity_id
         WHERE w.org_id=NEW.org_id AND w.id=NEW.scope_entity_id AND w.voided_at IS NULL
           AND w.closed_on IS NULL
           AND e.voided_at IS NULL AND e.closed_on IS NULL;
        IF chain IS NULL THEN
            SELECT ARRAY[id] INTO chain FROM legal_entities
             WHERE org_id=NEW.org_id AND id=NEW.scope_entity_id AND voided_at IS NULL
               AND closed_on IS NULL;
        END IF;
        IF chain IS NULL THEN
            RAISE EXCEPTION 'setting_scope_unknown' USING ERRCODE = '23514';
        END IF;
    END IF;
    SELECT o.value INTO cur_value
      FROM tenant_setting_overrides o
     WHERE o.org_id = NEW.org_id
       AND o.key = NEW.key
       AND o.effective_from <= NEW.effective_from
       AND (o.scope_entity_id IS NULL OR o.scope_entity_id = ANY(chain))
     ORDER BY array_position(chain, o.scope_entity_id) NULLS LAST, o.effective_from DESC
     LIMIT 1;
    cur_ord := COALESCE(setting_ordinal(d.kind, d.codes, cur_value), d.default_ordinal);
    looser := CASE
        WHEN d.looser_when = 'neutral' THEN false
        WHEN cur_ord IS NULL THEN true
        WHEN d.looser_when = 'higher' THEN new_ord > cur_ord
        ELSE new_ord < cur_ord
    END;
    NEW.direction := CASE
        WHEN looser THEN 'loosen'
        WHEN d.looser_when = 'neutral' OR new_ord = cur_ord THEN 'neutral'
        ELSE 'tighten'
    END;
    NEW.onboarding_exempt := false;
    IF looser AND NEW.effective_from < now() + interval '24 hours' THEN
        IF NOT tenant_setting_onboarding(NEW.org_id) THEN
            RAISE EXCEPTION 'setting_loosening_delay' USING ERRCODE = '23514', DETAIL = NEW.key;
        END IF;
        NEW.onboarding_exempt := true;
    END IF;
    RETURN NEW;
END;
$$;

/* Rollback: restore this previous function body after rolling the binary back.
CREATE OR REPLACE FUNCTION tenant_setting_overrides_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
    d          RECORD;
    new_ord    BIGINT;
    cur_value  JSONB;
    cur_ord    BIGINT;
    looser     BOOLEAN;
BEGIN
    SELECT * INTO d FROM setting_definition(NEW.key);
    IF d.kind IS NULL THEN
        RAISE EXCEPTION 'setting_unknown_key' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF d.governance <> 'tenant' THEN
        RAISE EXCEPTION 'setting_not_editable' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    new_ord := setting_ordinal(d.kind, d.codes, NEW.value);
    IF new_ord IS NULL THEN
        RAISE EXCEPTION 'setting_value_invalid' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF d.kind = 'int' AND (new_ord < d.min_value OR new_ord > d.max_value) THEN
        RAISE EXCEPTION 'setting_out_of_range' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    IF NEW.effective_from < now() THEN
        RAISE EXCEPTION 'setting_backdated' USING ERRCODE = '23514', DETAIL = NEW.key;
    END IF;
    SELECT o.value INTO cur_value
      FROM tenant_setting_overrides o
     WHERE o.org_id = NEW.org_id
       AND o.key = NEW.key
       AND o.effective_from <= NEW.effective_from
       AND (o.scope_entity_id IS NULL OR o.scope_entity_id = NEW.scope_entity_id)
     ORDER BY (o.scope_entity_id IS NULL), o.effective_from DESC
     LIMIT 1;
    cur_ord := COALESCE(setting_ordinal(d.kind, d.codes, cur_value), d.default_ordinal);
    looser := CASE
        WHEN d.looser_when = 'neutral' THEN false
        WHEN cur_ord IS NULL THEN true
        WHEN d.looser_when = 'higher' THEN new_ord > cur_ord
        ELSE new_ord < cur_ord
    END;
    NEW.direction := CASE
        WHEN looser THEN 'loosen'
        WHEN d.looser_when = 'neutral' OR new_ord = cur_ord THEN 'neutral'
        ELSE 'tighten'
    END;
    NEW.onboarding_exempt := false;
    IF looser AND NEW.effective_from < now() + interval '24 hours' THEN
        IF NOT tenant_setting_onboarding(NEW.org_id) THEN
            RAISE EXCEPTION 'setting_loosening_delay' USING ERRCODE = '23514', DETAIL = NEW.key;
        END IF;
        NEW.onboarding_exempt := true;
    END IF;
    RETURN NEW;
END;
$$;
*/
