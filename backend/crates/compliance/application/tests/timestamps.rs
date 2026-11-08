// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_compliance_application::{ArrivalEvent, AuditStreamRecord, LocationConsentLedgerEntry};
use console_compliance_domain::LocationConsentState;
use console_kernel_core::{BranchId, Timestamp, UserId};
use serde_json::{Value, to_value};
use time::macros::datetime;

fn responses(at: Timestamp) -> Vec<Result<Value, serde_json::Error>> {
    vec![
        to_value(LocationConsentLedgerEntry {
            id: "entry".into(),
            consent_id: "consent".into(),
            user_id: UserId::new(),
            branch_id: BranchId::new(),
            actor: None,
            action: "consent.grant".into(),
            from_status: LocationConsentState::NoRecord,
            to_status: LocationConsentState::Granted,
            occurred_at: at,
            created_at: at,
        }),
        to_value(ArrivalEvent {
            id: "arrival".into(),
            work_order_id: "order".into(),
            site_id: "site".into(),
            work_order_no: "order".into(),
            site_name: "site".into(),
            customer_name: "customer".into(),
            mechanic_name: "mechanic".into(),
            latitude: None,
            longitude: None,
            kind: "ARRIVAL".into(),
            occurred_at: at,
        }),
        to_value(AuditStreamRecord {
            id: "audit".into(),
            actor: None,
            action: "read".into(),
            target_type: "work_order".into(),
            target_id: "order".into(),
            sensitivity: "internal".into(),
            before_snap: None,
            after_snap: None,
            trace_id: "trace".into(),
            span_id: "span".into(),
            occurred_at: at,
            created_at: at,
        }),
    ]
}

#[test]
fn response_timestamps_are_fractional_utc_strings() {
    for response in responses(datetime!(2026-11-05 12:31:02.238349 +09:00)) {
        let response = response.unwrap();
        assert_eq!(response["occurred_at"], "2026-11-05T03:31:02.238349Z");
        if let Some(created) = response.get("created_at") {
            assert_eq!(created, "2026-11-05T03:31:02.238349Z");
        }
    }
}

#[test]
fn response_timestamps_refuse_unrepresentable_values() {
    for response in responses(datetime!(-0001-01-01 00:00 UTC)) {
        assert!(response.is_err());
    }
}
