// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! Optional solo authentication preserves the ordinary correction request.

use console_hr_adapter_postgres::lifecycle::correct::CorrectLifecycleEventRequest;
use serde_json::json;

#[test]
fn lifecycle_correction_accepts_an_optional_step_up() {
    let mut body = json!({
        "replacement": {
            "event_type": "LEAVE_OF_ABSENCE", "leave_type": "PERSONAL",
            "effective_date": "2026-09-01", "comment": "정정"
        },
        "reason_code": "INPUT_ERROR"
    });
    serde_json::from_value::<CorrectLifecycleEventRequest>(body.clone()).unwrap();
    body["step_up"] = serde_json::Value::Null;
    serde_json::from_value::<CorrectLifecycleEventRequest>(body.clone()).unwrap();
    body["step_up"] = json!({"binding": {}});
    assert!(serde_json::from_value::<CorrectLifecycleEventRequest>(body).is_err());
}

#[tokio::test]
async fn invalid_replacement_is_rejected_before_opening_a_transaction() {
    use console_hr_adapter_postgres::HrService;
    use console_kernel_core::{BranchScope, OrgId, UserId};
    use console_platform_authz::{Principal, Role};
    use std::collections::BTreeSet;

    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://localhost/unused")
        .unwrap();
    let principal = Principal::new(
        UserId::new(),
        OrgId::new(),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
    .with_tenant_ops(true);
    let request = serde_json::from_value(
        json!({"replacement": {"unexpected": true}, "reason_code": "INPUT_ERROR"}),
    )
    .unwrap();
    let error = HrService::new(pool)
        .correct_lifecycle_event(
            principal,
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            request,
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.status.as_u16(), 422);
}
