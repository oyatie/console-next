// SPDX-License-Identifier: LicenseRef-Proprietary
use console_gate_migration_safety::check_workspace;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[path = "support/migration_class.rs"]
mod support;
use support::{Fixture, NEW_VERSION, TestResult};

fn refuses(sql: &str, code: &str) -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write(NEW_VERSION, sql)?;
    let result = check_workspace(&fixture.0)?;
    assert!(
        result
            .violations
            .iter()
            .any(|v| format!("{:?}", v.kind) == code),
        "expected {code} for {sql}: {result:?}"
    );
    Ok(())
}
macro_rules! contract_fixture {
    ($name:ident, $sql:expr) => {
        #[test]
        fn $name() -> TestResult {
            refuses(
                concat!("-- migration-class: expand\n", $sql),
                "MigrationClassMismatch",
            )
        }
    };
}
contract_fixture!(drop_column, "ALTER TABLE sample DROP COLUMN old;");
contract_fixture!(drop_table, "DROP TABLE sample;");
contract_fixture!(drop_constraint, "ALTER TABLE sample DROP CONSTRAINT old;");
contract_fixture!(drop_function, "DROP FUNCTION old();");
contract_fixture!(drop_type, "DROP TYPE old;");
contract_fixture!(rename, "ALTER TABLE sample RENAME COLUMN old TO newer;");
contract_fixture!(
    alter_type,
    "ALTER TABLE sample ALTER COLUMN amount TYPE bigint;"
);
contract_fixture!(
    set_data_type,
    "ALTER TABLE sample ALTER amount SET DATA TYPE bigint;"
);
contract_fixture!(
    set_not_null,
    "ALTER TABLE sample ALTER COLUMN amount SET NOT NULL;"
);
contract_fixture!(delete, "DELETE FROM sample WHERE obsolete;");
contract_fixture!(update, "UPDATE sample SET amount = 0;");
contract_fixture!(truncate, "TRUNCATE sample;");
contract_fixture!(revoke, "REVOKE SELECT ON sample FROM reader;");
contract_fixture!(unparsable, "THIS IS NOT SQL;");
contract_fixture!(
    unknown_alter,
    "ALTER TABLE sample ENABLE ROW LEVEL SECURITY;"
);
contract_fixture!(
    with_delete,
    "WITH removed AS (DELETE FROM sample RETURNING *) SELECT * FROM removed;"
);
contract_fixture!(
    multiple_actions,
    "ALTER TABLE sample ADD COLUMN note text, ALTER COLUMN amount SET NOT NULL;"
);
contract_fixture!(malformed_create, "CREATE TABLE;");
contract_fixture!(malformed_add, "ALTER TABLE sample ADD COLUMN;");
contract_fixture!(
    unterminated_quote,
    "CREATE TABLE sample (note text DEFAULT 'unterminated);"
);

#[test]
fn missing_header_is_refused_after_cutoff() -> TestResult {
    refuses("CREATE TABLE sample (id int);", "MigrationClassHeader")
}
#[test]
fn invalid_duplicate_late_and_unreasoned_headers_are_refused() -> TestResult {
    for sql in [
        "-- migration-class: invalid\nCREATE TABLE sample (id int);",
        "-- migration-class: contract\nDROP TABLE sample;",
        "-- migration-class: expand\n-- migration-class: contract — remove old table\nDROP TABLE sample;",
        "CREATE TABLE sample (id int);\n-- migration-class: expand",
        "/*\n-- migration-class: expand\n*/ CREATE TABLE sample (id int);",
    ] {
        refuses(sql, "MigrationClassHeader")?;
    }
    Ok(())
}
#[test]
fn historical_migrations_are_grandfathered() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write(1, "DELETE FROM sample;")?;
    assert!(check_workspace(&fixture.0)?.passed());
    Ok(())
}
#[test]
fn additive_statements_and_explicit_compatibility_assertions_pass() -> TestResult {
    for sql in [
        "CREATE TABLE sample (id int); ALTER TABLE sample ADD COLUMN note text NULL; CREATE INDEX CONCURRENTLY sample_note ON sample (note);",
        "ALTER TABLE ONLY public.sample ADD COLUMN note text NULL;",
        "CREATE OR REPLACE FUNCTION sample() RETURNS int LANGUAGE SQL AS $$ SELECT 1; $$;",
        "CREATE OR REPLACE VIEW sample AS SELECT 1;",
        "-- migration-backfill: populate new column\nUPDATE sample SET note = 'new';",
        "-- migration-backfill: populate new column\nUPDATE public.sample SET note = 'new';",
        "-- migration-backfill: purge staging rows\nDELETE FROM sample; TRUNCATE scratch;",
    ] {
        let fixture = Fixture::new()?;
        fixture.write(NEW_VERSION, &format!("-- migration-class: expand\n{sql}"))?;
        let result = check_workspace(&fixture.0)?;
        assert!(result.passed(), "{sql}: {result:?}");
    }
    Ok(())
}
#[test]
fn contract_reason_and_conservative_class_are_accepted() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write(
        NEW_VERSION,
        "-- migration-class: contract — retire old data after N-1 drains\nDELETE FROM sample;",
    )?;
    assert!(check_workspace(&fixture.0)?.passed());
    fixture.write(
        NEW_VERSION,
        "-- migration-class: contract — reserved window\nCREATE TABLE sample (id int);",
    )?;
    assert!(check_workspace(&fixture.0)?.passed());
    Ok(())
}
#[test]
fn backfill_marker_never_exempts_ddl() -> TestResult {
    refuses(
        "-- migration-class: expand\n-- migration-backfill: migrate values\nALTER TABLE sample DROP COLUMN old;",
        "MigrationClassMismatch",
    )
}
#[test]
fn replacing_function_disagreement_explains_rehearsal() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write(NEW_VERSION, "CREATE OR REPLACE VIEW sample AS SELECT 1;")?;
    let result = check_workspace(&fixture.0)?;
    assert!(
        result
            .violations
            .iter()
            .any(|v| v.detail.contains("N-1") && v.detail.contains("rehearsal")),
        "{result:?}"
    );
    Ok(())
}
#[test]
fn summary_reports_only_committed_additions_with_json_escaping() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.git(&["init", "--quiet"])?;
    fixture.write(1, "SELECT 1;")?;
    fixture.commit()?;
    fixture.git(&["tag", "base"])?;
    fixture.write(
        NEW_VERSION,
        "-- migration-class: expand\nCREATE TABLE sample (id int);",
    )?;
    fixture.write(
        NEW_VERSION + 1,
        "-- migration-class: contract — remove \"old\" \\ data\nDROP TABLE sample;",
    )?;
    fixture.commit()?;
    fixture.write(NEW_VERSION + 2, "THIS IS NOT SQL;")?;
    let output = fixture.summary("base")?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout)?.trim(),
        format!(
            "{{\"{NEW_VERSION}\":{{\"class\":\"expand\",\"reason\":\"\"}},\"{}\":{{\"class\":\"contract\",\"reason\":\"remove \\\"old\\\" \\\\ data\"}}}}",
            NEW_VERSION + 1
        )
    );
    Ok(())
}
#[test]
fn summary_fails_closed_for_missing_ref_and_unclassified_addition() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.git(&["init", "--quiet"])?;
    fixture.write(1, "SELECT 1;")?;
    fixture.commit()?;
    fixture.git(&["tag", "base"])?;
    fixture.write(NEW_VERSION, "CREATE TABLE sample (id int);")?;
    fixture.commit()?;
    for base in ["base", "missing-ref"] {
        let output = fixture.summary(base)?;
        assert!(
            !output.status.success(),
            "{base}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stdout.is_empty());
    }
    Ok(())
}

contract_fixture!(
    unknown_second_action,
    "ALTER TABLE sample ADD COLUMN note text, ENABLE ROW LEVEL SECURITY;"
);
contract_fixture!(
    malformed_backfill,
    "-- migration-backfill: populate new column\nUPDATE sample;"
);
contract_fixture!(malformed_table_column, "CREATE TABLE sample (id);");
#[test]
fn cutoff_boundary_and_timestamp_precisions_are_checked() -> TestResult {
    let source =
        fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/config.rs"))?;
    let (_, value) = source.split_once('=').ok_or("missing cutoff")?;
    let cutoff: i64 = value.trim().trim_end_matches(';').parse()?;
    let fixture = Fixture::new()?;
    fixture.write(cutoff, "DELETE FROM sample;")?;
    assert!(check_workspace(&fixture.0)?.passed());
    fixture.write(cutoff + 1, "CREATE TABLE sample (id int);")?;
    assert!(!check_workspace(&fixture.0)?.passed());
    let fixture = Fixture::new()?;
    fs::write(
        fixture
            .0
            .join(format!("migrations/{}_future.sql", NEW_VERSION / 1000)),
        "CREATE TABLE sample (id int);",
    )?;
    assert!(!check_workspace(&fixture.0)?.passed());
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
#[test]
fn summary_reads_repository_paths_from_backend_cwd() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.git(&["init", "--quiet"])?;
    fs::create_dir_all(fixture.0.join("backend/migrations"))?;
    fs::write(
        fixture.0.join("backend/migrations/0001_old.sql"),
        "SELECT 1;",
    )?;
    fixture.commit()?;
    fixture.git(&["tag", "base"])?;
    fs::write(
        fixture
            .0
            .join(format!("backend/migrations/{NEW_VERSION}_new.sql")),
        "-- migration-class: expand\nCREATE TABLE sample (id int);",
    )?;
    fixture.commit()?;
    let output = Command::new(env!("CARGO_BIN_EXE_console-gate-migration-safety"))
        .args(["--summary", "base"])
        .current_dir(fixture.0.join("backend"))
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8(output.stdout)?.contains(&NEW_VERSION.to_string()));
    Ok(())
}

contract_fixture!(
    unclosed_dollar_quote,
    "CREATE OR REPLACE FUNCTION sample() RETURNS int LANGUAGE SQL AS $$ SELECT 1;"
);
contract_fixture!(unbalanced_parentheses, "CREATE TABLE sample (id int));");
contract_fixture!(missing_view_body, "CREATE OR REPLACE VIEW sample AS;");
#[test]
fn summary_rejects_underclassified_committed_migration() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.git(&["init", "--quiet"])?;
    fixture.write(1, "SELECT 1;")?;
    fixture.commit()?;
    fixture.git(&["tag", "base"])?;
    fixture.write(
        NEW_VERSION,
        "-- migration-class: expand\nDROP TABLE sample;",
    )?;
    fixture.commit()?;
    let output = fixture.summary("base")?;
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8(output.stderr)?.contains("inferred contract"));
    Ok(())
}

contract_fixture!(
    unclosed_tagged_dollar_quote,
    "CREATE OR REPLACE FUNCTION sample() RETURNS int LANGUAGE SQL AS $body$ SELECT 1;"
);
