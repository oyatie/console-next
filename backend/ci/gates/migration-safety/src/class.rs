// SPDX-License-Identifier: LicenseRef-Proprietary
//! Expand is a minimum syntactic class, not proof of N-1 behavioural compatibility.
//! Headers precede SQL: `-- migration-class: expand` or `contract — <reason>`.
//! Contract also accepts a separate `-- migration-reason: <reason>` header.
//! `-- migration-backfill: <reason>` exempts data writes only, never schema changes.
use crate::{
    GateResult, Violation, ViolationKind, config, order, sanitize_sql, tokenize_table_reference_sql,
};
use std::{collections::BTreeMap, path::Path, process::Command};

#[path = "expand.rs"]
mod expand;

fn applies(version: i64) -> bool {
    let normalized = if version.to_string().len() == 14 {
        version * 1000
    } else {
        version
    };
    normalized > config::GRANDFATHERED_THROUGH
}

fn header<'a>(content: &'a str, key: &str) -> Vec<&'a str> {
    content
        .lines()
        .map(str::trim)
        .take_while(|line| line.is_empty() || line.starts_with("--"))
        .filter_map(|line| line.strip_prefix(key).map(str::trim))
        .collect()
}

fn declaration(content: &str) -> Result<(&str, &str), String> {
    let headers = header(content, "-- migration-class:");
    let [value] = headers.as_slice() else {
        return Err(
            "declare exactly one leading -- migration-class: expand|contract header".into(),
        );
    };
    let (class, inline) = value.split_once(char::is_whitespace).unwrap_or((value, ""));
    let reasons = header(content, "-- migration-reason:");
    let reason = if reasons.is_empty() {
        inline.trim_start_matches([' ', '-', '—', ':'])
    } else if reasons.len() == 1 && inline.is_empty() {
        reasons[0]
    } else {
        return Err("declare one contract reason".into());
    };
    if !matches!(class, "expand" | "contract") || (class == "contract" && reason.is_empty()) {
        return Err("expected expand or contract with a one-line reason".into());
    }
    Ok((class, reason))
}

fn minimum(content: &str) -> &'static str {
    let backfill = header(content, "-- migration-backfill:")
        .iter()
        .any(|reason| !reason.is_empty());
    // Bodies are author assertions; the existing audit rules still inspect their SQL.
    let sanitized = sanitize_sql(content, true);
    let mut fresh = expand::FreshObjects::default();
    let mut depth = 0_i64;
    for ch in sanitized.chars() {
        if ch == '(' {
            depth += 1;
        }
        if ch == ')' {
            depth -= 1;
        }
        if depth < 0 {
            return "contract";
        }
    }
    if depth != 0 {
        return "contract";
    }
    let mut count = 0;
    for raw in sanitized.split(';') {
        let statement = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        let tokens = tokenize_table_reference_sql(&statement);
        if tokens.is_empty() {
            continue;
        }
        count += 1;
        let words: Vec<&str> = tokens.iter().map(String::as_str).collect();
        // An allowlist deliberately makes unfamiliar statements contract. Do not infer
        // compatibility from the absence of a destructive keyword.
        let additive = match words.as_slice() {
            ["create", "table", _, _, _, ..] => {
                statement.trim_end().ends_with(')') && statement.contains('(')
            }
            ["create", "index", ..] => {
                words.contains(&"on")
                    && statement.trim_end().ends_with(')')
                    && statement.contains('(')
            }
            ["create", "or", "replace", "function" | "view", _, ..]
            | ["create", "function" | "view", _, ..] => words
                .iter()
                .position(|word| *word == "as")
                .is_some_and(|index| index + 1 < words.len()),
            ["alter", "table", ..] => {
                crate::table_name_after_alter_table(&tokens, 2).is_some_and(|(_, start)| {
                    expand::column(&statement, &words[start..])
                        || fresh.rls(&words[2..], &words[start..])
                })
            }
            ["grant", _, ..] => statement.split_once(" on ").is_some_and(|(_, tail)| {
                tail.split_once(" to ")
                    .is_some_and(|(object, role)| !object.is_empty() && !role.is_empty())
            }),
            ["comment", "on", _, ..] => {
                matches!(words.last(), Some(&"__sql_literal__" | &"null")) && words.contains(&"is")
            }
            ["revoke", _, ..] => fresh.revoke(&statement),
            ["create", "policy", _, "on", rest @ ..] => fresh.policy(rest),
            [
                "set",
                "local",
                "lock_timeout" | "statement_timeout",
                "__sql_literal__",
            ] => statement.contains('='),
            ["delete", "from", _, ..] => backfill,
            ["truncate", _, ..] => backfill,
            ["update", _, "set", _, ..] | ["update", _, ".", _, "set", _, ..] => {
                backfill && statement.contains('=')
            }
            _ => false,
        };
        if !additive || words.contains(&"__unparsed_sql__") {
            return "contract";
        }
        fresh.remember(&statement, &words);
    }
    if count == 0 { "contract" } else { "expand" }
}

fn classify(content: &str) -> Result<(&str, &str), (ViolationKind, String)> {
    let rehearsal = "CREATE OR REPLACE FUNCTION/VIEW is expand only by author declaration; behavioural compatibility requires the N-1 rehearsal";
    let (class, reason) = declaration(content).map_err(|error| {
        (
            ViolationKind::MigrationClassHeader,
            format!("{error}; {rehearsal}"),
        )
    })?;
    if class == "expand" && minimum(content) == "contract" {
        return Err((
            ViolationKind::MigrationClassMismatch,
            format!(
                "declared expand is weaker than inferred contract (destructive, unknown or unparsable SQL); declare contract with a reason; {rehearsal}"
            ),
        ));
    }
    Ok((class, reason))
}

pub(super) fn check(file: &Path, content: &str, result: &mut GateResult) {
    let version = file
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.split_once('_'))
        .and_then(|(version, _)| version.parse().ok());
    if version.is_some_and(applies)
        && let Err((kind, detail)) = classify(content)
    {
        result.violations.push(Violation {
            kind,
            file: file.to_owned(),
            detail,
        });
    }
}

/// JSON version → declared class/reason for post-cutoff migrations added in base..HEAD.
/// Read committed blobs, exclude grandfathered history, and emit no partial summary on error.
pub fn summary(root: &Path, base: &str) -> Result<String, String> {
    let previous = order::migration_versions(root, base)?;
    let current = order::migration_versions(root, "HEAD")?;
    let mut entries = BTreeMap::new();
    for (file, version) in current {
        if previous.contains_key(&file) || !applies(version) {
            continue;
        }
        let output = Command::new("git")
            .args(["show", &format!("HEAD:{}", file.display())])
            .current_dir(root)
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        let content = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
        let (class, reason) =
            classify(&content).map_err(|(_, detail)| format!("{}: {detail}", file.display()))?;
        let value = format!(
            "\"{version}\":{{\"class\":{},\"reason\":{}}}",
            json_string(class),
            json_string(reason)
        );
        if entries.insert(version, value).is_some() {
            return Err(format!(
                "ambiguous migration version {version} across roots"
            ));
        }
    }
    Ok(format!(
        "{{{}}}",
        entries.into_values().collect::<Vec<_>>().join(",")
    ))
}

fn json_string(value: &str) -> String {
    let mut output = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            ch if ch.is_control() => output.push_str(&format!("\\u{:04x}", u32::from(ch))),
            ch => output.push(ch),
        }
    }
    output.push('"');
    output
}
