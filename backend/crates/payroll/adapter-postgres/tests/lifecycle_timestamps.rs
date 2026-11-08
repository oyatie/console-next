// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_payroll_adapter_postgres::lifecycle::{
    Disbursement, PayrollException, PayslipDeliveryItem, RunCalcSummary,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, macros::datetime};
use uuid::Uuid;

fn responses(at: OffsetDateTime, optional: Option<OffsetDateTime>) -> Vec<Value> {
    vec![
        serde_json::to_value(RunCalcSummary {
            version: 1,
            calculated_at: at,
            calculated_lines: 1,
            blocked_lines: 0,
            payable: false,
            kernel_rate_table: "verified".into(),
            total_net_won: None,
        })
        .unwrap(),
        serde_json::to_value(PayrollException {
            id: Uuid::nil(),
            run_id: Uuid::nil(),
            line_id: None,
            employee_id: None,
            employee_display_name: "person".into(),
            kind: "BLOCKED".into(),
            severity: "ERROR".into(),
            amount_delta_won: None,
            summary_ko: "확인 필요".into(),
            detail: json!({}),
            linked_refs: json!([]),
            status: "OPEN".into(),
            resolved_by: None,
            resolved_at: optional,
            resolved_reason: None,
            carried_from_run_id: None,
            created_at: at,
        })
        .unwrap(),
        serde_json::to_value(Disbursement {
            id: Uuid::nil(),
            run_id: Uuid::nil(),
            scheduled_at: at,
            status: "SCHEDULED".into(),
            attested_by: None,
            attested_at: optional,
            reason: None,
            created_at: at,
            updated_at: at,
        })
        .unwrap(),
        serde_json::to_value(PayslipDeliveryItem {
            line_id: Uuid::nil(),
            employee_id: Uuid::nil(),
            inbox_doc_id: Uuid::nil(),
            issued_at: at,
            acknowledged_at: optional,
        })
        .unwrap(),
    ]
}

#[test]
fn lifecycle_timestamps_are_fractional_utc_strings_and_options_remain_null() {
    let at = datetime!(2026-11-05 12:31:02.238349 +09:00);
    for optional in [Some(at), None] {
        let mut checked = 0;
        for response in responses(at, optional) {
            for (key, value) in response.as_object().unwrap() {
                if key.ends_with("_at") {
                    let nullable = matches!(
                        key.as_str(),
                        "resolved_at" | "attested_at" | "acknowledged_at"
                    );
                    let expected = if nullable && optional.is_none() {
                        Value::Null
                    } else {
                        json!("2026-11-05T03:31:02.238349Z")
                    };
                    assert_eq!(*value, expected, "{key}");
                    checked += 1;
                }
            }
        }
        assert_eq!(checked, 9);
    }
}
