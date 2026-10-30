// SPDX-License-Identifier: LicenseRef-Proprietary
use console_gate_migration_safety::{ViolationKind, check_workspace};
#[path = "support/migration_class.rs"]
#[expect(dead_code, reason = "shared fixture also supports summary CLI tests")]
mod support;
use support::{Fixture, NEW_VERSION, TestResult};

fn check(sql: &str, expand: bool) -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write(NEW_VERSION, &format!("-- migration-class: expand\n{sql}"))?;
    let result = check_workspace(&fixture.0)?;
    if expand {
        assert!(result.passed(), "{sql}: {result:?}");
    } else {
        assert!(
            result
                .violations
                .iter()
                .any(|v| v.kind == ViolationKind::MigrationClassMismatch),
            "{sql}: {result:?}"
        );
    }
    Ok(())
}

macro_rules! fixture {
    ($name:ident, $expand:expr, $sql:expr) => {
        #[test]
        fn $name() -> TestResult {
            check($sql, $expand)
        }
    };
}

fixture!(grant, true, "GRANT SELECT, INSERT ON sample TO console_rt;");
fixture!(
    local_lock_timeout,
    true,
    "SET LOCAL lock_timeout = '2s'; CREATE TABLE sample (id int);"
);
fixture!(
    local_statement_timeout,
    true,
    "SET LOCAL statement_timeout = '10s'; CREATE TABLE sample (id int);"
);
fixture!(
    replication_role,
    false,
    "SET LOCAL session_replication_role = 'replica';"
);
fixture!(search_path, false, "SET LOCAL search_path = 'untrusted';");
fixture!(
    comment,
    true,
    "COMMENT ON COLUMN sample.note IS 'DROP TABLE sample; it''s documentation';"
);
fixture!(
    nullable_column,
    true,
    "ALTER TABLE sample ADD COLUMN note text;"
);
fixture!(
    quoted_column,
    true,
    "ALTER TABLE sample ADD COLUMN \"Note\" text NULL;"
);
fixture!(
    string_default,
    true,
    "ALTER TABLE sample ADD COLUMN origin text NOT NULL DEFAULT 'command';"
);
fixture!(
    boolean_default,
    true,
    "ALTER TABLE sample ADD COLUMN enabled boolean DEFAULT false NOT NULL;"
);
fixture!(
    numeric_default,
    true,
    "ALTER TABLE sample ADD COLUMN amount numeric(12,2) NOT NULL DEFAULT -1.25;"
);
fixture!(
    timestamp_type,
    true,
    "ALTER TABLE ONLY public.sample ADD COLUMN known_at timestamp with time zone NULL;"
);
fixture!(
    multiword_type,
    true,
    "ALTER TABLE sample ADD COLUMN amount double precision;"
);
fixture!(
    new_table_rls,
    true,
    "CREATE TABLE sample (id uuid); ALTER TABLE sample ENABLE ROW LEVEL SECURITY; ALTER TABLE sample FORCE ROW LEVEL SECURITY; CREATE POLICY org_isolation ON sample USING (id = current_setting('app.id')::uuid) WITH CHECK (id = current_setting('app.id')::uuid);"
);
fixture!(
    new_table_revoke,
    true,
    "CREATE TABLE public.sample (id uuid); REVOKE ALL PRIVILEGES ON TABLE public.sample FROM PUBLIC, console_rt; GRANT SELECT ON public.sample TO console_rt;"
);
fixture!(
    new_function_revoke,
    true,
    "CREATE FUNCTION public.sample() RETURNS int LANGUAGE SQL AS $$ SELECT 1; $$; REVOKE ALL ON FUNCTION public.sample() FROM PUBLIC;"
);
fixture!(
    plpgsql_body,
    true,
    "CREATE OR REPLACE FUNCTION sample() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id IS NULL THEN RAISE EXCEPTION 'missing'; END IF; RETURN NEW; END; $$;"
);
fixture!(
    tagged_body,
    true,
    "CREATE FUNCTION sample() RETURNS int AS $Body$ BEGIN PERFORM '($other$;'; RETURN 1; END; $Body$ LANGUAGE plpgsql;"
);
fixture!(
    quoted_body,
    true,
    "CREATE FUNCTION sample() RETURNS int AS 'BEGIN RETURN 1; END;' LANGUAGE plpgsql;"
);
fixture!(
    new_objects_together,
    true,
    "CREATE TABLE sample (id int); CREATE FUNCTION sample_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$; REVOKE ALL ON sample FROM PUBLIC; CREATE POLICY visible ON sample USING (true);"
);

fixture!(
    plain_unique_index,
    false,
    "CREATE UNIQUE INDEX u ON sample (note);"
);
fixture!(
    unique_constraint,
    false,
    "ALTER TABLE sample ADD CONSTRAINT u UNIQUE (note);"
);
fixture!(
    existing_policy,
    false,
    "CREATE POLICY narrowed ON sample AS RESTRICTIVE USING (false);"
);
fixture!(
    existing_rls,
    false,
    "ALTER TABLE sample FORCE ROW LEVEL SECURITY;"
);
fixture!(
    conditional_table_revoke,
    false,
    "CREATE TABLE IF NOT EXISTS sample (id int); REVOKE SELECT ON sample FROM reader;"
);
fixture!(
    replacement_revoke,
    false,
    "CREATE OR REPLACE FUNCTION sample() RETURNS int AS $$ SELECT 1; $$ LANGUAGE SQL; REVOKE ALL ON FUNCTION sample() FROM reader;"
);
fixture!(
    existing_overload_revoke,
    false,
    "CREATE FUNCTION sample() RETURNS int AS $$ SELECT 1; $$ LANGUAGE SQL; REVOKE ALL ON FUNCTION sample(int) FROM reader;"
);
fixture!(
    different_schema_revoke,
    false,
    "CREATE TABLE fresh.sample (id int); REVOKE SELECT ON old.sample FROM reader;"
);
fixture!(
    quoted_name_revoke,
    false,
    "CREATE TABLE \"Sample\" (id int); REVOKE SELECT ON sample FROM reader;"
);
fixture!(
    quoted_case_revoke,
    false,
    "CREATE TABLE \"Sample\" (id int); REVOKE SELECT ON \"sample\" FROM reader;"
);
fixture!(
    quoted_case_policy,
    false,
    "CREATE TABLE \"Sample\" (id int); CREATE POLICY p ON \"sample\" USING (false);"
);
fixture!(
    mixed_revoke,
    false,
    "CREATE TABLE sample (id int); REVOKE SELECT ON sample, existing FROM reader;"
);
fixture!(
    late_create,
    false,
    "REVOKE SELECT ON sample FROM reader; CREATE TABLE sample (id int);"
);
fixture!(
    not_null_without_default,
    false,
    "ALTER TABLE sample ADD COLUMN note text NOT NULL;"
);
fixture!(
    null_not_null_default,
    false,
    "ALTER TABLE sample ADD COLUMN note text DEFAULT NULL NOT NULL;"
);
fixture!(
    expression_default,
    false,
    "ALTER TABLE sample ADD COLUMN known_at timestamptz DEFAULT now();"
);
fixture!(
    computed_default,
    false,
    "ALTER TABLE sample ADD COLUMN amount int DEFAULT 1 / 0;"
);
fixture!(
    column_reference,
    false,
    "ALTER TABLE sample ADD COLUMN other_id uuid REFERENCES other(id);"
);
fixture!(
    column_check,
    false,
    "ALTER TABLE sample ADD COLUMN amount numeric(12,2) CHECK (amount > 0);"
);
fixture!(
    multiple_actions,
    false,
    "ALTER TABLE sample ADD COLUMN amount numeric(12,2), ALTER COLUMN note SET NOT NULL;"
);
fixture!(
    body_followed_by_drop,
    false,
    "CREATE FUNCTION sample() RETURNS int AS $$ SELECT 1; $$ LANGUAGE SQL; DROP TABLE existing;"
);
fixture!(
    dollar_tag_case_mismatch,
    false,
    "CREATE FUNCTION sample() RETURNS int AS $Body$ SELECT 1; $body$ LANGUAGE SQL;"
);
fixture!(
    body_followed_by_revoke,
    false,
    "CREATE FUNCTION sample() RETURNS int AS $$ SELECT 1; $$ LANGUAGE SQL; REVOKE SELECT ON existing FROM reader;"
);
fixture!(malformed_grant, false, "GRANT SELECT ON sample TO;");
fixture!(malformed_comment, false, "COMMENT ON TABLE sample IS;");
fixture!(no_sql, false, "");
fixture!(
    empty_backfill,
    false,
    "-- migration-backfill:\nUPDATE sample SET note = 'new';"
);
fixture!(
    unclosed_string_body,
    false,
    "CREATE OR REPLACE VIEW sample AS SELECT 'x"
);

#[test]
fn function_body_masking_preserves_existing_audit_rules() -> TestResult {
    for (body, kind) in [
        ("DROP TABLE audit_events;", ViolationKind::DropAuditedTable),
        (
            "GRANT DELETE ON audit_events TO reader;",
            ViolationKind::GrantAuditEventsMutation,
        ),
        (
            "REVOKE ALL ON sample FROM console_app;",
            ViolationKind::RevokeTableOwnerPrivileges,
        ),
    ] {
        let fixture = Fixture::new()?;
        fixture.write(NEW_VERSION, &format!("-- migration-class: expand\nCREATE OR REPLACE FUNCTION sample() RETURNS void LANGUAGE plpgsql AS $$ BEGIN {body} END; $$;"))?;
        assert!(
            check_workspace(&fixture.0)?
                .violations
                .iter()
                .any(|v| v.kind == kind)
        );
    }
    Ok(())
}

#[test]
fn separate_contract_reason_header_is_supported() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write(
        NEW_VERSION,
        "-- migration-class: contract\n-- migration-reason: retire old data\nDROP TABLE sample;",
    )?;
    assert!(check_workspace(&fixture.0)?.passed());
    Ok(())
}
