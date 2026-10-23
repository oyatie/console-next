// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{GateResult, Violation, ViolationKind};
use std::path::Path;

pub(super) fn check_table_owner_revokes(file: &Path, tokens: &[String], result: &mut GateResult) {
    for (index, token) in tokens.iter().enumerate() {
        if token != "revoke" {
            continue;
        }
        let tail = &tokens[index + 1..];
        let Some(on) = tail.iter().position(|token| token == "on") else {
            continue;
        };
        let Some(from) = tail.iter().position(|token| token == "from") else {
            continue;
        };
        if from <= on || !tail[from + 1..].iter().any(|token| token == "console_app") {
            continue;
        }
        let object = &tail[on + 1..from];
        let table = object.first().is_some_and(|kind| {
            ![
                "function",
                "procedure",
                "routine",
                "sequence",
                "schema",
                "database",
                "type",
                "domain",
                "language",
                "tablespace",
                "parameter",
                "foreign",
                "large",
            ]
            .contains(&kind.as_str())
                && (kind != "all" || object.get(1).is_some_and(|kind| kind == "tables"))
        });
        if table {
            result.violations.push(Violation {
                kind: ViolationKind::RevokeTableOwnerPrivileges,
                file: file.to_path_buf(),
                detail: "REVOKE table privileges FROM console_app breaks migration-owner commands"
                    .into(),
            });
        }
    }
}

pub(super) fn check_audit_events_grants(file: &Path, tokens: &[String], result: &mut GateResult) {
    if !tokens.iter().any(|token| token == "grant")
        || !tokens.iter().any(|token| token == "audit_events")
    {
        return;
    }

    let on_index = tokens.iter().position(|token| token == "on");
    let grants_mutation = tokens
        .iter()
        .take(on_index.unwrap_or(tokens.len()))
        .any(|token| token == "update" || token == "delete");

    if grants_mutation {
        result.violations.push(Violation {
            kind: ViolationKind::GrantAuditEventsMutation,
            file: file.to_path_buf(),
            detail: "GRANT UPDATE/DELETE on audit_events is forbidden".to_string(),
        });
    }
}

pub(super) fn check_audit_events_trigger(file: &Path, tokens: &[String], result: &mut GateResult) {
    let disables_trigger = tokens
        .windows(2)
        .any(|window| window[0].as_str() == "disable" && window[1].as_str() == "trigger");
    if disables_trigger && tokens.iter().any(|token| token == "audit_events") {
        result.violations.push(Violation {
            kind: ViolationKind::DisableAuditEventsTrigger,
            file: file.to_path_buf(),
            detail: "DISABLE TRIGGER on audit_events is forbidden".to_string(),
        });
    }
}
