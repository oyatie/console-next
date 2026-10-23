-- SPDX-License-Identifier: LicenseRef-Proprietary
-- Validate proposed facts before compatibility triggers restore frozen columns.
-- The original table constraints remain the single owner of each validation rule.
CREATE FUNCTION console_validate_person_fact_projection() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE field RECORD; guard RECORD; valid BOOLEAN; columns SMALLINT[];
    facts JSONB:=to_jsonb(NEW);
BEGIN
    SELECT array_agg(attnum) INTO columns FROM pg_attribute
    WHERE attrelid=TG_RELID AND attname=ANY(TG_ARGV) AND NOT attisdropped;
    FOR field IN SELECT attname FROM pg_attribute
        WHERE attrelid=TG_RELID AND attnum=ANY(columns) AND attnotnull LOOP
        IF facts->field.attname='null'::JSONB THEN
            RAISE EXCEPTION USING ERRCODE='23502',TABLE=TG_TABLE_NAME,COLUMN=field.attname,
                MESSAGE='null value in column "'||field.attname||'" violates not-null constraint';
        END IF;
    END LOOP;
    FOR guard IN SELECT conname,pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint
        WHERE conrelid=TG_RELID AND contype='c' AND conkey && columns LOOP
        EXECUTE format('SELECT %s FROM (SELECT ($1::%s).*) proposed',guard.expression,TG_RELID::regclass)
            INTO valid USING NEW;
        IF valid IS FALSE THEN
            RAISE EXCEPTION USING ERRCODE='23514',TABLE=TG_TABLE_NAME,CONSTRAINT=guard.conname,
                MESSAGE='new row violates check constraint "'||guard.conname||'"';
        END IF;
    END LOOP;
    RETURN NEW;
END $$;

CREATE TRIGGER check_person_fact_constraints BEFORE UPDATE OF display_name,phone ON users
    FOR EACH ROW EXECUTE FUNCTION console_validate_person_fact_projection('display_name','phone');
CREATE TRIGGER check_person_fact_constraints BEFORE UPDATE OF name,birth_date ON employees
    FOR EACH ROW EXECUTE FUNCTION console_validate_person_fact_projection('name','birth_date');
CREATE TRIGGER check_person_fact_constraints BEFORE UPDATE OF phone_e164 ON employee_employment_profiles
    FOR EACH ROW EXECUTE FUNCTION console_validate_person_fact_projection('phone_e164');
