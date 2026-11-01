// SPDX-License-Identifier: LicenseRef-Proprietary
use console_gate_migration_safety::check_workspace;
#[path = "support/migration_class.rs"]
#[expect(dead_code, reason = "shared fixture also supports summary CLI tests")]
mod support;
use support::{Fixture, NEW_VERSION, TestResult};

fn check(sql: &str, marker: &str) -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write(
        NEW_VERSION,
        &format!("-- migration-class: contract — after expand release\n{marker}\n{sql}"),
    )?;
    let result = check_workspace(&fixture.0)?;
    if marker == "-- contract-of: 20261030100000000" {
        assert!(result.passed(), "{sql}: {result:?}");
    } else {
        assert!(
            result
                .violations
                .iter()
                .any(|v| format!("{:?}", v.kind) == "MigrationClassHeader"),
            "{sql}: {result:?}"
        );
    }
    Ok(())
}

macro_rules! contract {
    ($name:ident, $sql:expr) => {
        #[test]
        fn $name() -> TestResult {
            check($sql, "")?;
            check($sql, "-- contract-of: 20261030100000000")
        }
    };
}
contract!(
    required_column,
    "ALTER TABLE sample ADD COLUMN sensitive boolean NOT NULL;"
);
contract!(
    required_array,
    "ALTER TABLE sample ADD COLUMN basis text[] NOT NULL CHECK (cardinality(basis) > 0);"
);
contract!(
    set_not_null,
    "ALTER TABLE sample ALTER COLUMN amount SET NOT NULL;"
);
contract!(
    existing_check,
    "ALTER TABLE sample ADD CONSTRAINT positive CHECK (amount > 0);"
);
contract!(drop_table, "DROP TABLE sample;");
contract!(drop_column, "ALTER TABLE sample DROP COLUMN old;");
contract!(
    drop_constraint,
    "ALTER TABLE sample DROP CONSTRAINT positive;"
);

#[test]
fn contract_marker_must_be_single_leading_and_nonempty_version() -> TestResult {
    for marker in [
        "-- contract-of:",
        "-- contract-of: unrelated",
        "-- contract-of: 0356\n-- contract-of: 0357",
        "/*\n-- contract-of: 0356\n*/",
        "DROP TABLE other;\n-- contract-of: 0356",
    ] {
        check(
            "ALTER TABLE sample ALTER COLUMN amount SET NOT NULL;",
            marker,
        )?;
    }
    Ok(())
}

#[test]
fn unreleased_pay_group_migration_is_expand() -> TestResult {
    let sql = include_str!(
        "../../../../crates/platform/db/migrations/20261030100000000_pay_group_explicit_basis.sql"
    );
    assert_eq!(sql.lines().nth(1), Some("-- migration-class: expand"));
    let fixture = Fixture::new()?;
    fixture.write(NEW_VERSION, sql)?;
    let result = check_workspace(&fixture.0)?;
    assert!(result.passed(), "{result:?}");
    Ok(())
}

#[test]
fn nullable_new_column_check_can_explicitly_admit_old_writers() -> TestResult {
    let fixture = Fixture::new()?;
    fixture.write(NEW_VERSION, "-- migration-class: expand\nALTER TABLE sample ADD COLUMN basis text[] CHECK (basis IS NULL OR (cardinality(basis) > 0));")?;
    let result = check_workspace(&fixture.0)?;
    assert!(result.passed(), "{result:?}");
    Ok(())
}

#[test]
fn null_guard_cannot_hide_a_second_action_or_required_column() -> TestResult {
    for sql in [
        "ALTER TABLE sample ADD COLUMN basis text[] NOT NULL CHECK (basis IS NULL OR (cardinality(basis) > 0));",
        "ALTER TABLE sample ADD COLUMN basis text[] CHECK (basis IS NULL OR (cardinality(basis) > 0)), DROP COLUMN old;",
        "ALTER TABLE sample ADD COLUMN basis text[] CHECK (other IS NULL OR (cardinality(basis) > 0));",
        "ALTER TABLE sample ADD CONSTRAINT c CHECK (basis IS NULL OR (cardinality(basis) > 0));",
        "ALTER TABLE sample ADD COLUMN basis text[] CHECK (basis IS NULL OR (cardinality(basis) > 0)) CHECK (false);",
        "ALTER TABLE sample ADD COLUMN basis text[] DEFAULT 'invalid' CHECK (basis IS NULL OR (cardinality(basis) > 0));",
    ] {
        let fixture = Fixture::new()?;
        fixture.write(NEW_VERSION, &format!("-- migration-class: expand\n{sql}"))?;
        assert!(!check_workspace(&fixture.0)?.passed(), "{sql}");
    }
    Ok(())
}

#[test]
#[ignore = "set RELEASE_MIGRATION_LINT to the release checkout's scripts/migration-lint.sh"]
fn release_lint_and_ci_agree_on_shared_ddl_fixtures() -> TestResult {
    let lint = std::env::var("RELEASE_MIGRATION_LINT")?;
    // Table CHECK and DROP CONSTRAINT are stricter in CI; the release script misses them.
    for (sql, additive) in [
        (
            "ALTER TABLE sample ADD COLUMN sensitive boolean NOT NULL;",
            false,
        ),
        (
            "ALTER TABLE sample ALTER COLUMN amount SET NOT NULL;",
            false,
        ),
        ("ALTER TABLE sample DROP COLUMN old;", false),
        ("DROP TABLE sample;", false),
        (
            "ALTER TABLE sample ADD COLUMN sensitive boolean NOT NULL DEFAULT false;",
            true,
        ),
        ("ALTER TABLE sample ADD COLUMN note text;", true),
        (
            include_str!(
                "../../../../crates/platform/db/migrations/20261030100000000_pay_group_explicit_basis.sql"
            ),
            true,
        ),
    ] {
        for marker in ["", "-- contract-of: 20261030100000000"] {
            let fixture = Fixture::new()?;
            fixture.git(&["init", "--quiet"])?;
            fixture.write(1, "CREATE TABLE sample (amount int,old text);")?;
            fixture.commit()?;
            fixture.git(&["tag", "base"])?;
            let sql = sql
                .lines()
                .filter(|line| !line.starts_with("-- migration-class:"))
                .collect::<Vec<_>>()
                .join("\n");
            fixture.write(
                NEW_VERSION,
                &format!(
                    "-- migration-class: {}\n{marker}\n{sql}",
                    if additive {
                        "expand"
                    } else {
                        "contract — after expand release"
                    }
                ),
            )?;
            fixture.commit()?;
            let base = std::process::Command::new("git")
                .args(["rev-parse", "base"])
                .current_dir(&fixture.0)
                .output()?;
            let tip = std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&fixture.0)
                .output()?;
            let output = std::process::Command::new("bash")
                .arg(&lint)
                .args([
                    String::from_utf8(base.stdout)?.trim(),
                    String::from_utf8(tip.stdout)?.trim(),
                ])
                .env("BACKEND_REPO", &fixture.0)
                .env("BASE_REPO", &fixture.0)
                .env("MIGRATIONS_DIR", "migrations")
                .env_remove("REROOT_BASE_SHA")
                .env_remove("REROOT_FROM_FE")
                .output()?;
            let ci = check_workspace(&fixture.0)?;
            assert_eq!(
                output.status.success(),
                ci.passed(),
                "{sql}, {marker}: {ci:?}; {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(ci.passed(), additive || !marker.is_empty(), "{sql}");
        }
    }
    Ok(())
}
