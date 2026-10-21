//! SQL string data must not require audit, while executable mutations still do.
use console_gate_audit_coverage::{ViolationKind, check_source_tree};
use std::fs;

fn check(tag: &str, statements: &str, mutating: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("audit-sql-{tag}-{}", std::process::id()));
    let src = root.join("app/src");
    fs::create_dir_all(&src)?;
    fs::write(
        src.join("probe.rs"),
        format!("pub async fn probe(pool: &PgPool) {{ {statements} }}"),
    )?;
    let result = check_source_tree(&root);
    fs::remove_dir_all(&root)?;
    assert_eq!(result.examined, usize::from(mutating), "{tag}: {result:?}");
    if mutating {
        assert_eq!(result.violations.len(), 1, "{tag}: {result:?}");
        assert_eq!(result.violations[0].kind, ViolationKind::MissingAuditEvent);
        assert_eq!(result.violations[0].function_name.as_deref(), Some("probe"));
    } else {
        assert!(result.passed(), "{tag}: {result:?}");
    }
    Ok(())
}

#[test]
fn read_only_privilege_names_are_sql_data_not_mutations() -> Result<(), Box<dyn std::error::Error>>
{
    check(
        "schema-privileges",
        r#"sqlx::query_scalar("SELECT count(*) FROM aclexplode(d.defaclacl) a WHERE a.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')").fetch_one(pool).await;"#,
        false,
    )
}

#[test]
fn read_only_sql_values_identifiers_and_comments_do_not_count_as_dml()
-> Result<(), Box<dyn std::error::Error>> {
    let literals = [
        r##"r#"SELECT 'can''t DELETE', E'can\'t UPDATE'"#"##,
        r###"r##"SELECT "DELETE", $$UPDATE$$, $data$INSERT$data$ FROM notes"##"###,
        "\"SELECT 1 /* DELETE /* UPDATE */ INSERT */ -- TRUNCATE\\n FOR UPDATE\"",
        r#""SELECT 'FOR' AS label FOR UPDATE""#,
    ];
    for (i, literal) in literals.into_iter().enumerate() {
        check(
            &format!("read-only-{i}"),
            &format!("sqlx::query({literal}).fetch_one(pool).await;"),
            false,
        )?;
    }
    Ok(())
}

#[test]
fn executable_dml_and_mutating_ctes_still_require_audit() -> Result<(), Box<dyn std::error::Error>>
{
    let literals = [
        r#""INSERT INTO notes (value) VALUES ('DELETE')""#,
        r#""UPDATE notes SET value = 'INSERT'""#,
        r#""DELETE FROM notes""#,
        r#""MERGE INTO notes USING other ON true WHEN MATCHED THEN DELETE""#,
        r#""TRUNCATE notes""#,
        r#""WITH gone AS (DELETE FROM notes RETURNING *) SELECT * FROM gone""#,
        r#""WITH changed AS (UPDATE notes SET value = 'DELETE' RETURNING *) SELECT * FROM changed""#,
        r#""SELECT 'FOR'; UPDATE notes SET value = 'same'""#,
        r##"r#"SELECT E'can\'t'; DELETE FROM notes"#"##,
        r##"r#"SELECT E'x\\'; UPDATE notes SET value = 'same'"#"##,
        r##"r#"SELECT '\\'; DELETE FROM notes"#"##,
        r#""SELECT E'can\\'t'; DELETE FROM notes""#,
        "\"SELECT 1 -- hint\\n; DELETE FROM notes\"",
        r#""SELECT 1; \x55PDATE notes SET value = 'same'""#,
        r#""SELECT 1; \u{44}ELETE FROM notes""#,
        r##"r#"DO $$ BEGIN DELETE FROM notes; END $$"#"##,
        r##"r#"SELECT 'can''t UPDATE'; DELETE FROM notes"#"##,
    ];
    for (i, literal) in literals.into_iter().enumerate() {
        check(
            &format!("mutation-{i}"),
            &format!("sqlx::query({literal}).execute(pool).await;"),
            true,
        )?;
    }
    Ok(())
}

#[test]
fn sql_quote_or_comment_in_another_rust_literal_cannot_hide_a_write()
-> Result<(), Box<dyn std::error::Error>> {
    for (i, value) in ["'", "--", "/*"].into_iter().enumerate() {
        check(
            &format!("separate-literals-{i}"),
            &format!(
                r#"let label = "{value}"; sqlx::query("DELETE FROM notes").execute(pool).await;"#
            ),
            true,
        )?;
    }
    Ok(())
}
