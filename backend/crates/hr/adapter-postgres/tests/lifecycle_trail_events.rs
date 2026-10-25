// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Lifecycle writers retain one transactional trail through replay and undo.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use console_hr_adapter_postgres::cases::LifecycleCase;
use console_hr_adapter_postgres::clock::today_kst;
use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::Duration;
use uuid::Uuid;

fn request(kind: &str, on: time::Date, extra: Value) -> CreateEmployeeLifecycleEventRequest {
    let mut body =
        json!({"event_type":kind,"effective_date":on.to_string(),"comment":"생애 사건 회귀 검증"});
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(body).unwrap()
}

async fn hire(pool: PgPool, kind: &str) -> (fixture::Fixture, Uuid) {
    let f = fixture::fixture(pool).await;
    let mut body = f.body("lifecycle-events-hire", kind);
    body.hire_date = Some((today_kst() - Duration::days(1)).to_string());
    if kind == "CONTRACT" {
        body.contract_end_date = Some((today_kst() + Duration::days(1)).to_string());
    }
    let employee = f.create(body).await.unwrap().employee_id();
    (f, employee)
}

async fn event_case(
    f: &fixture::Fixture,
    employee: Uuid,
    event: Uuid,
    kind: &str,
) -> LifecycleCase {
    let mut cases: Vec<_> =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .into_iter()
            .filter(|case| case.trigger_id == Some(event))
            .collect();
    assert_eq!(cases.len(), 1, "one case per lifecycle event");
    let case = cases.remove(0);
    assert_eq!(case.kind, kind);
    assert!(!case.items.is_empty());
    case
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn leave_return_renewal_and_appointment_each_open_their_case_once(pool: PgPool) {
    let (f, employee) = hire(pool, "CONTRACT").await;
    let on = today_kst();
    for (event, kind, extra) in [
        (
            "LEAVE_OF_ABSENCE",
            "LEAVE_START",
            json!({"leave_type":"PERSONAL","expected_return_date":on.to_string()}),
        ),
        ("RETURN_FROM_LEAVE", "LEAVE_RETURN", json!({})),
        (
            "CONTRACT_RENEWAL",
            "CONTRACT",
            json!({"contract_end_date":(on+Duration::days(2)).to_string()}),
        ),
        ("APPOINT", "APPOINT", json!({"to_job":"개발"})),
    ] {
        let key = Uuid::new_v4().to_string();
        let recorded =
            f.hr.record_lifecycle_event(
                f.principal.clone(),
                employee,
                key.clone(),
                request(event, on, extra.clone()),
            )
            .await
            .unwrap();
        let id = Uuid::parse_str(recorded["id"].as_str().unwrap()).unwrap();
        let case = event_case(&f, employee, id, kind).await;
        let replay =
            f.hr.record_lifecycle_event(
                f.principal.clone(),
                employee,
                key,
                request(event, on, extra),
            )
            .await
            .unwrap();
        assert_eq!(replay["id"], recorded["id"]);
        assert_eq!(event_case(&f, employee, id, kind).await.id, case.id);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_cancel_keeps_its_case_and_withdrawal_reason(pool: PgPool) {
    let (f, employee) = hire(pool, "REGULAR").await;
    let recorded =
        f.hr.record_lifecycle_event(
            f.principal.clone(),
            employee,
            Uuid::new_v4().to_string(),
            request(
                "APPOINT",
                today_kst() + Duration::days(1),
                json!({"to_job":"개발"}),
            ),
        )
        .await
        .unwrap();
    let id = Uuid::parse_str(recorded["id"].as_str().unwrap()).unwrap();
    let case = event_case(&f, employee, id, "APPOINT").await;
    assert!(
        case.items
            .iter()
            .all(|item| item.status == "PENDING_TRIGGER")
    );
    let reason = "인사 일정 변경으로 철회";
    f.hr.cancel_lifecycle_event(
        f.principal.clone(),
        employee,
        id,
        serde_json::from_value(json!({"reason":reason})).unwrap(),
    )
    .await
    .unwrap();
    let cancelled = event_case(&f, employee, id, "APPOINT").await;
    assert_eq!(cancelled.id, case.id);
    assert_eq!(cancelled.state, "CANCELLED");
    assert_eq!(cancelled.cancellation_reason.as_deref(), Some(reason));
    assert!(
        cancelled
            .items
            .iter()
            .all(|item| item.status == "CANCELLED")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rescission_cancels_the_original_trail_without_creating_another_case(pool: PgPool) {
    let (f, employee) = hire(pool, "REGULAR").await;
    let recorded =
        f.hr.record_lifecycle_event(
            f.principal.clone(),
            employee,
            Uuid::new_v4().to_string(),
            request("APPOINT", today_kst(), json!({"to_job":"개발"})),
        )
        .await
        .unwrap();
    let id = Uuid::parse_str(recorded["id"].as_str().unwrap()).unwrap();
    let case = event_case(&f, employee, id, "APPOINT").await;
    let reason = "직무 발령 입력 오류";
    let undone =
        f.hr.rescind_lifecycle_event(
            f.principal.clone(),
            employee,
            id,
            serde_json::from_value(
                json!({"reason_code":"INPUT_ERROR","note":reason,"confirm_cascades":true}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let cancelled = event_case(&f, employee, id, "APPOINT").await;
    assert_eq!(cancelled.id, case.id);
    assert_eq!(cancelled.state, "CANCELLED");
    assert_eq!(cancelled.cancellation_reason.as_deref(), Some(reason));
    let undo_id = undone.rescinded.unwrap().id;
    assert!(
        !f.hr
            .employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .iter()
            .any(|case| case.trigger_id == Some(undo_id))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_apply_reuses_the_pending_case(pool: PgPool) {
    let (f, employee) = hire(pool, "REGULAR").await;
    let on = today_kst() + Duration::days(1);
    let recorded =
        f.hr.record_lifecycle_event(
            f.principal.clone(),
            employee,
            Uuid::new_v4().to_string(),
            request("APPOINT", on, json!({"to_job":"개발"})),
        )
        .await
        .unwrap();
    let id = Uuid::parse_str(recorded["id"].as_str().unwrap()).unwrap();
    let before = event_case(&f, employee, id, "APPOINT").await;
    assert_eq!(f.hr.apply_due(on).await.unwrap(), 1);
    let after = event_case(&f, employee, id, "APPOINT").await;
    assert_eq!(after.id, before.id);
    assert_eq!(after.items.len(), before.items.len());
    assert!(
        after
            .items
            .iter()
            .any(|item| item.status == "DONE_OBSERVED")
    );
}
