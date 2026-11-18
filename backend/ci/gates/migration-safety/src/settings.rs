// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{GateResult, Violation, ViolationKind, table_name_after_alter_table};
use std::path::Path;

pub(super) fn check(file: &Path, content: &str, tokens: &[String], result: &mut GateResult) {
    let Some(version) = file
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.split('_').next())
        .and_then(|prefix| prefix.parse::<i64>().ok())
    else {
        return;
    };
    let version = if version.to_string().len() == 14 {
        version * 1000
    } else {
        version
    };
    if version <= 20261117160918000 {
        return;
    }
    let removal = content
        .lines()
        .map(str::trim)
        .take_while(|line| line.is_empty() || line.starts_with("--"))
        .filter_map(|line| line.strip_prefix("-- setting-definitions-removal:"))
        .any(|reason| !reason.trim().is_empty());
    for (index, token) in tokens.iter().enumerate() {
        let rest = &tokens[index + 1..];
        let object = match (token.as_str(), rest.first().map(String::as_str)) {
            ("create", Some("function")) | ("drop", Some("function" | "table")) => {
                Some((rest[0].as_str(), index + 2))
            }
            ("create", Some("or"))
                if rest.get(1).is_some_and(|t| t == "replace")
                    && rest.get(2).is_some_and(|t| t == "function") =>
            {
                Some(("function", index + 4))
            }
            ("delete", Some("from")) => Some(("table", index + 2)),
            ("truncate", _) => Some((
                "table",
                index + 1 + usize::from(rest.first().is_some_and(|t| t == "table")),
            )),
            _ => None,
        };
        let Some((kind, start)) = object else {
            continue;
        };
        let Some((name, _)) = table_name_after_alter_table(tokens, start) else {
            continue;
        };
        let target = if kind == "function" {
            "setting_definition"
        } else {
            "setting_definitions"
        };
        let touches_target = name == target
            || (matches!(token.as_str(), "drop" | "truncate")
                && tokens[start..].iter().any(|name| name == target));
        if touches_target && (kind == "function" || !removal) {
            result.violations.push(Violation {
                kind: ViolationKind::SettingDefinitionRewrite, file: file.to_owned(),
                detail: "add or update individual setting_definitions rows; never rebuild setting_definition(). Removing retired rows requires a leading -- setting-definitions-removal: <compatibility reason> header".into(),
            });
        }
    }
}
