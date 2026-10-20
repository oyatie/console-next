use console_gate_audit_coverage::check_workspace;
use std::fs;
use std::path::{Path, PathBuf};

fn temp_workspace(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!(
        "console-audit-gate-test-{name}-{}",
        std::process::id()
    ));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn write_file(path: &Path, content: &str) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

#[test]
fn audit_coverage_gate_flags_raw_insert_without_source() -> Result<(), Box<dyn std::error::Error>> {
    let ws = temp_workspace("raw-audit-insert")?;
    write_file(&ws.join("app/src/lib.rs"), "")?;
    write_file(
        &ws.join("crates/platform/db/src/audit_write.rs"),
        include_str!("../../../../crates/platform/db/src/audit_write.rs"),
    )?;
    write_file(
        &ws.join("crates/platform/request-context/src/commands.rs"),
        include_str!("../../../../crates/platform/request-context/src/commands.rs"),
    )?;
    let refresh = ws.join("crates/platform/auth/src/refresh_audit.rs");
    write_file(
        &refresh,
        include_str!("../../../../crates/platform/auth/src/refresh_audit.rs"),
    )?;
    let clean = check_workspace(&ws)?;
    assert!(clean.passed(), "{:#?}", clean.violations);

    let raw = r#"pub async fn raw(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>) {
        sqlx::query("INSERT INTO audit_events (id, actor, action) VALUES ($1, $2, $3)")
            .execute(tx.as_mut()).await;
    }"#;
    // Neither test fixtures nor comments may be charged as production writers.
    write_file(&ws.join("crates/platform/auth/tests/fixture.rs"), raw)?;
    write_file(
        &refresh,
        &format!(
            "#[cfg(test)]\nmod tests {{ {raw} }}\n/* {raw} */\n\
             const READ: &str = \"SELECT 'INSERT INTO audit_events', $$INSERT INTO audit_events$$\";"
        ),
    )?;
    let fixtures = check_workspace(&ws)?;
    assert!(fixtures.passed(), "{:#?}", fixtures.violations);

    for sql in [
        "INSERT INTO audit_events (id, actor, action)",
        "INSERT INTO audit_events (id, actor, action, source)",
        "insert\ninto\npublic.audit_events (id)",
        "INSERT/* hint */INTO public . \"audit_events\" (id)",
    ] {
        write_file(
            &refresh,
            &format!(
                "pub async fn raw(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>) {{\n\
                 sqlx::query(r#\"{sql} VALUES ($1)\"#).execute(tx.as_mut()).await;\n}}"
            ),
        )?;
        let rejected = check_workspace(&ws)?;
        assert!(
            rejected
                .violations
                .iter()
                .any(|v| v.file == refresh && v.detail.contains("shared audit writer")),
            "real gate accepted {sql}: {:#?}",
            rejected.violations
        );
    }
    fs::remove_dir_all(ws)?;
    Ok(())
}
