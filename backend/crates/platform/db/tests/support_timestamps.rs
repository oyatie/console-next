// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_platform_db::support::Session;
use serde_json::{Value, json};
use time::macros::datetime;
use uuid::Uuid;

#[test]
fn support_session_timestamps_normalize_offsets_and_preserve_nulls() {
    let at = datetime!(2026-11-05 12:31:02.238349 +09:00);
    for optional in [Some(at), None] {
        let session = Session {
            id: Uuid::nil(),
            org_id: Uuid::nil(),
            operator_ref: Uuid::nil(),
            operator_label: "operator".into(),
            reason_code: "DIAGNOSE".into(),
            scope: vec!["hr_basic".into()],
            state: "REQUESTED".into(),
            masked: true,
            reveal_classes: vec![],
            requested_duration_seconds: 60,
            approved_duration_seconds: None,
            requested_at: at,
            request_expires_at: at,
            operator_approver_ref: None,
            tenant_approved_at: optional,
            expires_at: optional,
        };
        let wire = serde_json::to_value(session).unwrap();
        for field in ["requested_at", "request_expires_at"] {
            assert_eq!(wire[field], "2026-11-05T03:31:02.238349Z", "{field}");
        }
        for field in ["tenant_approved_at", "expires_at"] {
            assert_eq!(
                wire[field],
                optional.map_or(Value::Null, |_| json!("2026-11-05T03:31:02.238349Z")),
                "{field}"
            );
        }
    }
}
