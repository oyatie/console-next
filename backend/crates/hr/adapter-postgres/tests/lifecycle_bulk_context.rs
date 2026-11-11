// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/lifecycle_grant.rs"]
mod lifecycle_grant;

use console_hr_adapter_postgres::clock::today_kst;
use console_inbox_adapter_postgres::PgInboxStore;
use console_leave_adapter_postgres::PgLeaveStore;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use time::{Date, Duration};
use uuid::Uuid;

async fn employee(pool: &PgPool) -> (fixture::Fixture, Uuid) {
    let f = fixture::fixture(pool.clone()).await;
    lifecycle_grant::grant(
        pool,
        *f.principal.org_id.as_uuid(),
        *f.principal.user_id.as_uuid(),
    )
    .await;
    let mut body = f.body("bulk-context", "REGULAR");
    body.hire_date = Some(today_kst().to_string());
    let id = f.create(body).await.unwrap().employee_id();
    (f, id)
}

fn appoint(ids: &[Uuid], on: Date) -> Value {
    json!({"event_type":"APPOINT", "employee_ids":ids, "to_job":"개발",
        "effective_date":on.to_string(), "comment":"직무 발령"})
}

async fn refusal(f: &fixture::Fixture, request: Value, employee: Uuid, code: &str) {
    let preview =
        f.hr.preview_bulk_lifecycle_events(
            f.principal.clone(),
            serde_json::from_value(request.clone()).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(preview.refusals[0]["employee_id"], json!(employee));
    assert_eq!(preview.refusals[0]["code"], code);
    let error =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            Uuid::new_v4().to_string(),
            serde_json::from_value(request).unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (422, "bulk_lifecycle_refused")
    );
    assert_eq!(*error.refusals.unwrap(), json!(preview.refusals));
    let detail =
        f.hr.employee_detail(f.principal.clone(), employee)
            .await
            .unwrap();
    assert_eq!(
        detail.employee.job.as_deref(),
        None,
        "a refused batch cannot change the job"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_dates_before_hire_are_named_in_preview_and_commit(pool: PgPool) {
    let (f, id) = employee(&pool).await;
    refusal(
        &f,
        appoint(&[id], today_kst() - Duration::days(1)),
        id,
        "effective_date_before_hire",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_appointments_meet_the_preloaded_scheduled_exit(pool: PgPool) {
    let (f, id) = employee(&pool).await;
    let on = today_kst() + Duration::days(10);
    // The exit workflow owns termination; its stored reservation is the input to bulk planning.
    sqlx::query("INSERT INTO employee_lifecycle_events(org_id,employee_id,event_type,from_status,to_status,effective_date,comment,created_by,state,scheduled_request) \
        VALUES ($1,$2,'TERMINATE','ACTIVE','EXITED',$3,'퇴직 예약',$4,'SCHEDULED',$5)")
        .bind(f.principal.org_id.as_uuid()).bind(id).bind(on.to_string()).bind(f.principal.user_id.as_uuid())
        .bind(json!({"event_type":"TERMINATE","to_status":"EXITED","effective_date":on.to_string(),"comment":"퇴직 예약",
            "signoffs":{"privacy_notice_ack":true,"korean_labor_law_ack":true,"payroll_cutoff_ack":true,"retirement_settlement_ack":true}}))
        .execute(&pool).await.unwrap();
    refusal(
        &f,
        appoint(&[id], on + Duration::days(1)),
        id,
        "lifecycle_scheduled_state",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cancelled_reservations_do_not_change_a_bulk_appointments_projected_head(pool: PgPool) {
    let (f, id) = employee(&pool).await;
    let on = today_kst() + Duration::days(10);
    let first =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            Uuid::new_v4().to_string(),
            serde_json::from_value(appoint(&[id], on)).unwrap(),
        )
        .await
        .unwrap();
    let event: Uuid = serde_json::from_value(first["items"][0]["id"].clone()).unwrap();
    f.hr.cancel_lifecycle_event(
        f.principal.clone(),
        id,
        event,
        serde_json::from_value(json!({"reason":"입력 오류"})).unwrap(),
    )
    .await
    .unwrap();
    let cancelled =
        f.hr.lifecycle_events(f.principal.clone(), id, Default::default(), false)
            .await
            .unwrap();
    assert!(
        cancelled
            .items
            .iter()
            .any(|item| item.id == event && item.state == "CANCELLED")
    );
    let done =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            Uuid::new_v4().to_string(),
            serde_json::from_value(appoint(&[id], on + Duration::days(1))).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(done["items"][0]["state"], "SCHEDULED");
    assert_eq!(done["items"][0]["to_job"], "개발");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_missing_bulk_head_is_a_per_person_not_found_refusal(pool: PgPool) {
    let (f, id) = employee(&pool).await;
    let missing = Uuid::new_v4();
    let request = appoint(&[id, missing], today_kst());
    let preview =
        f.hr.preview_bulk_lifecycle_events(
            f.principal.clone(),
            serde_json::from_value(request.clone()).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        preview.refusals,
        vec![json!({"employee_id":missing,"code":"not_found","message":"employee not found"})]
    );
    assert_eq!(preview.counts.will_apply, 1);
    let error =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            Uuid::new_v4().to_string(),
            serde_json::from_value(request).unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (422, "bulk_lifecycle_refused")
    );
    assert_eq!(*error.refusals.unwrap(), json!(preview.refusals));
    let detail = f.hr.employee_detail(f.principal.clone(), id).await.unwrap();
    assert_eq!(detail.employee.job.as_deref(), None);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn merged_away_people_do_not_refuse_a_new_registration(pool: PgPool) {
    let (f, merged) = employee(&pool).await;
    let mut survivor = f.body("surviving-person", "REGULAR");
    survivor.name = "박유지".into();
    let survivor = f.create(survivor).await.unwrap().employee_id();
    sqlx::query("UPDATE employees SET merged_into_employee_id=$2 WHERE id=$1")
        .bind(merged)
        .bind(survivor)
        .execute(&pool)
        .await
        .unwrap();
    let store = || PgLeaveStore::new(f.rt.clone(), Arc::new(PgInboxStore::new(f.rt.clone())));
    let registration = |key| {
        let mut body = f.body(key, "REGULAR");
        body.home_branch_id = None;
        body
    };
    let (_, created) =
        f.hr.create_employee(f.principal.clone(), store(), registration("new-namesake"))
            .await
            .unwrap();
    let created = created.employee_id();
    assert_ne!(created, merged);
    assert_ne!(created, survivor);
    let refusal =
        f.hr.create_employee(
            f.principal.clone(),
            store(),
            registration("duplicate-new-namesake"),
        )
        .await
        .unwrap_err();
    assert_eq!(refusal.code, "duplicate_candidate");
    let candidates = refusal.refusals.unwrap();
    assert_eq!(candidates[0]["employee_id"], json!(created));
    assert!(
        !candidates
            .as_array()
            .unwrap()
            .iter()
            .any(|candidate| candidate["employee_id"] == json!(merged))
    );
}
