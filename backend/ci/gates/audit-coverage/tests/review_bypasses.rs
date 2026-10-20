use console_gate_audit_coverage::{ViolationKind, check_source_tree};
use std::{fs, path::PathBuf};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn root(name: &str) -> Result<PathBuf, std::io::Error> {
    let path = std::env::temp_dir().join(format!("review-audit-{name}-{}", std::process::id()));
    fs::create_dir_all(path.join("crates/platform/auth/src"))?;
    Ok(path)
}

#[test]
fn review_production_only_writer_is_not_exempt() -> TestResult {
    let path = root("cfg-not-test")?;
    let file = path.join("crates/platform/auth/src/raw.rs");
    for (predicate, test_only) in [
        ("not(test)", false),
        ("not(\n    test\n)", false),
        ("not(all(test))", false),
        ("any(test, feature = \"mock\")", false),
        ("all(not(test), feature = \"production\")", false),
        ("not(any(test, feature = \"mock\"))", false),
        ("feature = \"test\"", false),
        ("test", true),
        ("all(test, feature = \"mock\")", true),
        ("all(feature = \"mock\", test)", true),
        ("any(test)", true),
        ("not(not(test))", true),
    ] {
        fs::write(
            &file,
            format!(
                "#[cfg({predicate})]\npub async fn production() {{\n\
                 sqlx::query(\"INSERT INTO audit_events(id) VALUES ($1)\");\n}}"
            ),
        )?;
        let result = check_source_tree(&path);
        assert_eq!(
            result.passed(),
            test_only,
            "cfg({predicate}): {:?}",
            result.violations
        );
        if !test_only {
            assert!(result.violations.iter().any(|violation| {
                violation.kind == ViolationKind::MissingAuditEvent
                    && violation.detail.contains("shared audit writer")
            }));
        }
    }
    fs::remove_dir_all(path)?;
    Ok(())
}

#[test]
fn review_unicode_escaped_sql_identifier_is_not_exempt() -> TestResult {
    let path = root("unicode-ident")?;
    for sql in [
        r#"INSERT INTO U&"audit_\0065vents"(id) VALUES ($1)"#,
        r#"INSERT INTO public.U&"audit_\+000065vents"(id) VALUES ($1)"#,
        r#"INSERT INTO U&"audit_!0065vents" UESCAPE '!' (id) VALUES ($1)"#,
        r#"INSERT INTO U&"public".audit_events(id) VALUES ($1)"#,
    ] {
        fs::write(
            path.join("crates/platform/auth/src/raw.rs"),
            format!("pub async fn production() {{ sqlx::query(r#\"{sql}\"#); }}"),
        )?;
        let result = check_source_tree(&path);
        assert!(!result.passed(), "Unicode identifier escaped: {sql}");
    }
    fs::remove_dir_all(path)?;
    Ok(())
}

#[test]
fn review_external_sql_writer_is_not_exempt() -> TestResult {
    let path = root("include-sql")?;
    fs::write(
        path.join("crates/platform/auth/src/raw.sql"),
        "INSERT INTO audit_events(id) VALUES ($1)",
    )?;
    for query in [
        r#"sqlx::query(include_str!("raw.sql"))"#,
        r#"query(include_str!("raw.sql"))"#,
        r#"const SQL: &str = include_str!("raw.sql")"#,
        r#"sqlx::query_as::<_, Row>(include_str!("raw.sql"))"#,
        r#"sqlx::query!(include_str!("raw.sql"))"#,
        r#"sqlx::query_file!("src/raw.sql")"#,
        r#"sqlx::query_file_as!(Row, "src/raw.sql")"#,
        r#"sqlx::query_file_scalar!("src/raw.sql")"#,
        r#"sqlx::query(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/raw.sql")))"#,
    ] {
        fs::write(
            path.join("crates/platform/auth/src/raw.rs"),
            format!("pub async fn production() {{ {query}; }}"),
        )?;
        let result = check_source_tree(&path);
        assert!(!result.passed(), "external SQL writer escaped: {query}");
    }
    fs::remove_dir_all(path)?;
    Ok(())
}

#[test]
fn comments_sql_data_and_non_sql_includes_remain_allowed() -> TestResult {
    let path = root("read-only")?;
    fs::write(
        path.join("crates/platform/auth/src/schema.yaml"),
        "type: object",
    )?;
    fs::write(path.join("crates/platform/auth/src/read.sql"), "SELECT 1")?;
    for source in [
        r#"const SCHEMA: &str = include_str!("schema.yaml");"#,
        r#"pub fn read() { sqlx::query(include_str!("read.sql")); }"#,
        r#"pub fn read() { let 이름 = include_str!("read.sql"); sqlx::query(이름); }"#,
        r#"const SCHEMA: &str = include_str!("schema.yaml"); pub fn read() { sqlx::query("SELECT 1"); }"#,
        r#"// sqlx::query_file!("raw.sql")"#,
        r#"/* sqlx::query(include_str!("raw.sql")) */"#,
        r#"pub fn read() { sqlx::query("SELECT 'include_str!', 'query_file!'"); }"#,
        r##"pub fn read() { sqlx::query(r#"SELECT 'INSERT INTO U&"audit_\0065vents"'"#); }"##,
        r#"pub fn write() { sqlx::query("INSERT INTO users(id) VALUES (1)"); }"#,
    ] {
        fs::write(path.join("crates/platform/auth/src/raw.rs"), source)?;
        let result = check_source_tree(&path);
        assert!(result.passed(), "{source}: {:?}", result.violations);
    }
    fs::remove_dir_all(path)?;
    Ok(())
}
