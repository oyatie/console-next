// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct Repository(PathBuf);

impl Repository {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "migration-order-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("backend/migrations"))?;
        let repo = Self(root);
        repo.git(&["init", "--quiet"])?;
        repo.git(&["config", "user.name", "Jason Lee"])?;
        repo.git(&[
            "config",
            "user.email",
            "56489493+jason931225@users.noreply.github.com",
        ])?;
        Ok(repo)
    }

    fn git(&self, args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.0)
            .output()?;
        assert!(output.status.success(), "{}", output_text(&output));
        Ok(String::from_utf8(output.stdout)?.trim().into())
    }

    fn write(&self, file: &str, sql: &str) -> TestResult {
        let file = self.0.join(file);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(file, sql)?;
        Ok(())
    }

    fn commit(&self) -> Result<String, Box<dyn std::error::Error>> {
        self.git(&["add", "."])?;
        self.git(&["commit", "--quiet", "-m", "test: migration fixture"])?;
        self.git(&["rev-parse", "HEAD"])
    }

    fn gate(&self, base: Option<&str>) -> Result<Output, std::io::Error> {
        let mut command = Command::new(env!("CARGO_BIN_EXE_console-gate-migration-safety"));
        command.current_dir(self.0.join("backend"));
        command.env_remove("MIGRATION_BASE");
        if let Some(base) = base {
            command.env("MIGRATION_BASE", base);
        }
        command.output()
    }
}

impl Drop for Repository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn output_text(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn older_settings_and_statutory_redefinitions_are_refused() -> TestResult {
    let repo = Repository::new()?;
    repo.write(
        "backend/migrations/20261023061209000_employee_import_rollback.sql",
        "SELECT 1;",
    )?;
    let base = repo.commit()?;
    // The two lost-update shapes: a whole settings function and a statutory CHECK list.
    for (name, sql) in [
        (
            "20261022220000000_filings_settings.sql",
            "CREATE OR REPLACE FUNCTION setting_definition(p_key text) RETURNS text LANGUAGE SQL AS $$ SELECT 'filing.enabled' $$;",
        ),
        (
            "20261022220000001_rights_request.sql",
            "ALTER TABLE statutory_rules ADD CONSTRAINT statutory_rules_code_check CHECK (code IN ('rights_request'));",
        ),
    ] {
        repo.write(&format!("backend/migrations/{name}"), sql)?;
    }
    repo.commit()?;
    let output = repo.gate(Some(&base))?;
    let message = output_text(&output);
    assert!(!output.status.success(), "{message}");
    assert!(
        message.contains("20261022220000000_filings_settings.sql"),
        "{message}"
    );
    assert!(
        message.contains("20261022220000001_rights_request.sql"),
        "{message}"
    );
    assert!(message.contains("20261023061209000"), "{message}");
    Ok(())
}

#[test]
fn additions_after_the_base_pass_with_legacy_and_unordered_history() -> TestResult {
    let repo = Repository::new()?;
    for name in [
        "0001_initial.sql",
        "20261023061209000_newer.sql",
        "20261022220000000_landed_later.sql",
    ] {
        repo.write(&format!("backend/migrations/{name}"), "SELECT 1;")?;
    }
    let base = repo.commit()?;
    repo.write("backend/migrations/20261023061209001_next.sql", "SELECT 1;")?;
    repo.write("backend/migrations/20261023061209002_next.sql", "SELECT 1;")?;
    repo.commit()?;
    let output = repo.gate(Some(&base))?;
    assert!(output.status.success(), "{}", output_text(&output));
    Ok(())
}

#[test]
fn comparison_uses_target_tip_instead_of_branch_point() -> TestResult {
    let repo = Repository::new()?;
    repo.write(
        "backend/migrations/20261022000000000_initial.sql",
        "SELECT 1;",
    )?;
    let fork = repo.commit()?;
    repo.write(
        "backend/migrations/20261024000000000_target.sql",
        "SELECT 1;",
    )?;
    let target = repo.commit()?;
    repo.git(&["checkout", "--quiet", "--detach", &fork])?;
    repo.write(
        "backend/migrations/20261023000000000_branch.sql",
        "SELECT 1;",
    )?;
    repo.commit()?;
    repo.git(&["merge", "--quiet", "--no-edit", &target])?;
    let output = repo.gate(Some(&target))?;
    assert!(!output.status.success(), "{}", output_text(&output));
    assert!(output_text(&output).contains("20261024000000000"));
    Ok(())
}

#[test]
fn renaming_an_older_migration_cannot_hide_an_addition() -> TestResult {
    let repo = Repository::new()?;
    repo.write("backend/migrations/20261022000000000_old.sql", "SELECT 1;")?;
    repo.write(
        "backend/migrations/20261024000000000_latest.sql",
        "SELECT 1;",
    )?;
    let base = repo.commit()?;
    repo.git(&[
        "mv",
        "backend/migrations/20261022000000000_old.sql",
        "backend/migrations/20261023000000000_renamed.sql",
    ])?;
    repo.commit()?;
    let output = repo.gate(Some(&base))?;
    assert!(!output.status.success(), "{}", output_text(&output));
    Ok(())
}

#[test]
fn independent_directories_and_non_migration_sql_are_not_compared() -> TestResult {
    let repo = Repository::new()?;
    repo.write(
        "backend/migrations/20261024000000000_latest.sql",
        "SELECT 1;",
    )?;
    let base = repo.commit()?;
    repo.write("backend/other/migrations/0001_initial.sql", "SELECT 1;")?;
    repo.write("backend/queries/0000_query.sql", "SELECT 1;")?;
    repo.commit()?;
    let output = repo.gate(Some(&base))?;
    assert!(output.status.success(), "{}", output_text(&output));
    Ok(())
}

#[test]
fn changing_existing_files_and_running_without_a_base_pass() -> TestResult {
    let repo = Repository::new()?;
    repo.write("backend/migrations/20261022000000000_old.sql", "SELECT 1;")?;
    repo.write(
        "backend/migrations/20261024000000000_latest.sql",
        "SELECT 1;",
    )?;
    let base = repo.commit()?;
    repo.write("backend/migrations/20261022000000000_old.sql", "SELECT 2;")?;
    repo.commit()?;
    for base in [Some(base.as_str()), None, Some("")] {
        let output = repo.gate(base)?;
        assert!(output.status.success(), "{}", output_text(&output));
    }
    Ok(())
}

#[test]
fn an_unavailable_base_fails_closed() -> TestResult {
    let repo = Repository::new()?;
    repo.write("backend/migrations/0001_initial.sql", "SELECT 1;")?;
    repo.commit()?;
    let output = repo.gate(Some("missing-base"))?;
    assert!(!output.status.success(), "{}", output_text(&output));
    assert!(output_text(&output).contains("missing-base"));
    Ok(())
}

#[test]
fn the_real_dev_tree_passes_when_it_adds_no_migrations() -> TestResult {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = Command::new(env!("CARGO_BIN_EXE_console-gate-migration-safety"))
        .current_dir(root)
        .env("MIGRATION_BASE", "HEAD")
        .output()?;
    assert!(output.status.success(), "{}", output_text(&output));
    Ok(())
}
