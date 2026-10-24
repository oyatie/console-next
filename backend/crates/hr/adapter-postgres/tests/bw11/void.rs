//! BW-11 정정 (correct) and 취소·철회 (rescind).

use console_hr_adapter_postgres::lifecycle::correct::CorrectLifecycleEventRequest;
use console_hr_adapter_postgres::lifecycle::void::RescindLifecycleEventRequest;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{fixture, person_fixtures, promote};

fn rescind(confirm: bool) -> RescindLifecycleEventRequest {
    serde_json::from_value(json!({"reason_code": "INPUT_ERROR", "confirm_cascades": confirm}))
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_rescission_previews_then_restores_the_head_once(pool: PgPool) {
    let f = fixture(pool).await;
    let first = f
        .record(promote("대리", "2026-09-01", json!({})))
        .await
        .unwrap();
    let second = f
        .record(promote("과장", "2026-09-02", json!({})))
        .await
        .unwrap();
    let id = |v: &Value| Uuid::parse_str(v["id"].as_str().unwrap()).unwrap();
    let p = || f.principal.clone();
    let older =
        f.hr.rescind_lifecycle_event(p(), f.employee, id(&first), rescind(true))
            .await;
    assert_eq!(older.unwrap_err().code, "lifecycle_void_not_latest");

    let preview =
        f.hr.rescind_lifecycle_event(p(), f.employee, id(&second), rescind(false))
            .await
            .unwrap();
    assert!(preview.rescinded.is_none());
    assert_eq!(f.version().await, 2);
    let done =
        f.hr.rescind_lifecycle_event(p(), f.employee, id(&second), rescind(true))
            .await
            .unwrap();
    let row = done.rescinded.unwrap();
    assert_eq!(
        (row.event_type.as_str(), row.voids_event_id),
        ("RESCIND", Some(id(&second)))
    );
    assert_eq!(row.to_position.as_deref(), Some("대리"));
    assert_eq!(f.version().await, 3);
    let again =
        f.hr.rescind_lifecycle_event(p(), f.employee, id(&second), rescind(true))
            .await;
    assert_eq!(again.unwrap_err().code, "lifecycle_event_voided");
    // The earlier one is now the latest effective change.
    f.hr.rescind_lifecycle_event(p(), f.employee, id(&first), rescind(true))
        .await
        .unwrap();
    let position: Option<String> =
        sqlx::query_scalar("SELECT position FROM employees WHERE id = $1")
            .bind(f.employee)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(position.as_deref(), Some("사원"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_correction_replaces_the_event_on_its_date(pool: PgPool) {
    let f = fixture(pool).await;
    let leave = |kind: &str, extra: Value| {
        let mut body = json!({"event_type": "LEAVE_OF_ABSENCE", "leave_type": kind,
            "effective_date": "2026-09-01", "comment": "BW-11",
            "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true}});
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    };
    let original = f
        .record(serde_json::from_value(leave("PERSONAL", json!({}))).unwrap())
        .await
        .unwrap();
    let event = Uuid::parse_str(original["id"].as_str().unwrap()).unwrap();
    let correct = |replacement: Value| -> CorrectLifecycleEventRequest {
        serde_json::from_value(json!({"replacement": replacement, "reason_code": "INPUT_ERROR"}))
            .unwrap()
    };
    let p = || f.principal.clone();
    let moved = leave("PERSONAL", json!({"effective_date": "2026-09-02"}));
    assert_eq!(
        f.hr.correct_lifecycle_event(p(), f.employee, event, correct(moved), None)
            .await
            .unwrap_err()
            .status,
        422
    );
    let dated = leave("PERSONAL", json!({"expected_return_date": "2026-12-01"}));
    let refused =
        f.hr.correct_lifecycle_event(p(), f.employee, event, correct(dated), None)
            .await
            .unwrap_err();
    assert_eq!(refused.code, "second_person_required");

    let fixed =
        f.hr.correct_lifecycle_event(
            p(),
            f.employee,
            event,
            correct(leave("ILLNESS", json!({}))),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        (fixed.leave_type.as_deref(), fixed.voids_event_id),
        (Some("ILLNESS"), Some(event))
    );
    let page =
        f.hr.lifecycle_events(p(), f.employee, Default::default(), false)
            .await
            .unwrap();
    let voided = page.items.iter().find(|e| e.id == event).unwrap();
    assert_eq!(voided.voided_by, Some(fixed.id));
    let status: String =
        sqlx::query_scalar("SELECT employment_status FROM employees WHERE id = $1")
            .bind(f.employee)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(status, "ON_LEAVE");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn sensitive_correction_accepts_an_independent_current_holder(pool: PgPool) {
    let f = fixture(pool).await;
    person_fixtures::bind_user_to_distinct_person(&f.owner, f.principal.user_id).await;
    let leave = |date: &str| {
        serde_json::from_value(json!({
        "event_type": "LEAVE_OF_ABSENCE", "leave_type": "PERSONAL", "effective_date": "2026-09-01",
        "expected_return_date": date, "comment": "정정",
        "signoffs": {"privacy_notice_ack": true, "korean_labor_law_ack": true, "payroll_cutoff_ack": true}
    })).unwrap()
    };
    let original = f.record(leave("2026-12-01")).await.unwrap();
    let event: Uuid = original["id"].as_str().unwrap().parse().unwrap();
    let other = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, org_id, display_name, roles, is_tenant_ops) VALUES ($1,$2,'다른 담당자',ARRAY['SUPER_ADMIN'],true)")
        .bind(other).bind(f.principal.org_id.as_uuid()).execute(&f.owner).await.unwrap();
    person_fixtures::bind_user_to_distinct_person(
        &f.owner,
        console_kernel_core::UserId::from_uuid(other),
    )
    .await;
    let p = console_platform_authz::Principal::new(
        console_kernel_core::UserId::from_uuid(other),
        f.principal.org_id,
        std::collections::BTreeSet::from([console_platform_authz::Role::SuperAdmin]),
        console_kernel_core::BranchScope::All,
    )
    .with_tenant_ops(true);
    let body = CorrectLifecycleEventRequest {
        replacement: serde_json::to_value(leave("2026-12-15")).unwrap(),
        reason_code: "INPUT_ERROR".into(),
        note: None,
        step_up: None,
    };
    let fixed =
        f.hr.correct_lifecycle_event(p, f.employee, event, body, None)
            .await
            .unwrap();
    assert_eq!(fixed.expected_return_date.as_deref(), Some("2026-12-15"));
    assert_eq!(fixed.voids_event_id, Some(event));
}
