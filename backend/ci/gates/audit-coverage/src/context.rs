//! Audit source and intent-key admission are owned by the two shared boundaries.
use super::{GateResult, Violation, ViolationKind};
use std::{fs, path::Path};

pub(super) fn compute_test_mask(lines: &[&str]) -> Vec<bool> {
    let lines: Vec<_> = lines
        .iter()
        .map(|line| {
            let predicate = line.trim_start().strip_prefix("#[cfg(");
            if predicate.is_some()
                && predicate
                    .and_then(|rest| rest.split_once(")]"))
                    .and_then(|(predicate, _)| cfg_without_test(predicate))
                    != Some(false)
            {
                // The legacy mask treats every mention of `test` as test-only.
                line.replacen("#[cfg(", "#[production_cfg(", 1)
            } else {
                (*line).to_owned()
            }
        })
        .collect();
    super::mask::compute_test_mask(&lines.iter().map(String::as_str).collect::<Vec<_>>())
}

fn cfg_without_test(predicate: &str) -> Option<bool> {
    let predicate: String = super::strip_comments_and_strings(predicate)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if predicate == "test" {
        return Some(false);
    }
    let (operator, arguments) = predicate.split_once('(')?;
    let arguments = arguments.strip_suffix(')')?;
    let mut depth = 0i32;
    let mut values = arguments
        .split(|c| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            c == ',' && depth == 0
        })
        .filter(|argument| !argument.is_empty())
        .map(cfg_without_test);
    match operator {
        "not" => values.next()?.map(|value| !value),
        "all" | "any" => {
            let decisive = operator == "any";
            let mut unknown = false;
            for value in values {
                if value == Some(decisive) {
                    return Some(decisive);
                }
                unknown |= value.is_none();
            }
            (!unknown).then_some(!decisive)
        }
        _ => None,
    }
}

pub(super) fn check_raw_insert(file: &Path, source: &str, result: &mut GateResult) {
    if super::path_ends_with_repo_relative(file, "crates/platform/db/src/audit_write.rs") {
        return;
    }
    let lines: Vec<_> = source.lines().collect();
    let mask = super::compute_test_mask(&lines);
    let production = lines
        .iter()
        .zip(mask)
        .map(|(line, test)| if test { "" } else { *line })
        .collect::<Vec<_>>()
        .join("\n");
    if super::sql::contains_audit_insert(file, &production) {
        result.violations.push(Violation {
            kind: ViolationKind::MissingAuditEvent,
            file: file.to_path_buf(),
            function_name: None,
            detail: "audit_events inserts must use the shared audit writer in crates/platform/db/src/audit_write.rs".into(),
        });
    }
}

pub(super) fn check(root: &Path, mut result: GateResult) -> GateResult {
    for (path, required) in [
        (
            "crates/platform/db/src/audit_write.rs",
            &["context.source.as_str()", "row_hash_version", "command_id"] as &[&str],
        ),
        (
            "crates/platform/request-context/src/commands.rs",
            &[
                "validate_idempotency_key",
                "idempotency-key",
                "command_outcomes::reserve",
            ],
        ),
    ] {
        let file = root.join(path);
        let source = fs::read_to_string(&file).unwrap_or_default();
        if let Some(detail) = missing(&source, required) {
            result.violations.push(Violation {
                kind: ViolationKind::MissingAuditEvent,
                file,
                function_name: None,
                detail,
            });
        }
    }
    result
}
fn missing(source: &str, required: &[&str]) -> Option<String> {
    required
        .iter()
        .find(|fact| !source.contains(**fact))
        .map(|fact| format!("shared audit/command boundary omits {fact}"))
}
#[cfg(test)]
mod tests {
    #[test]
    fn audit_writer_without_source_is_refused() {
        let writer = include_str!("../../../../crates/platform/db/src/audit_write.rs");
        assert_eq!(super::missing(writer, &["context.source.as_str()"]), None);
        let omitted = writer.replace("context.source.as_str()", r#""FORM""#);
        assert!(super::missing(&omitted, &["context.source.as_str()"]).is_some());
    }
    #[test]
    fn write_admission_without_key_is_refused() {
        assert!(
            super::missing("command_outcomes::reserve", &["validate_idempotency_key"]).is_some()
        );
    }
}

pub(super) fn detects_unmarked_state_changing_handler(file: &Path, body: &str) -> bool {
    super::is_handler_surface(file) && super::sql::contains_state_mutating_sql(body)
}

#[cfg(test)]
mod sql_tests {
    #[test]
    fn select_privilege_and_json_names_are_read_only() {
        assert!(!super::super::sql::contains_state_mutating_sql(
            r#"sqlx::query("SELECT has_table_privilege('audit_events','INSERT'), json_build_object('delete','update')")"#
        ));
        assert!(super::super::sql::contains_state_mutating_sql(
            r#"sqlx::query("INSERT INTO audit_events(action) VALUES ('test.apply')")"#
        ));
    }
}
