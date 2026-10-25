//! 발령 공고 · 발령 번호 (EMP-UI 10).

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::lifecycle::requests::BulkEmployeeLifecycleEventRequest;
use console_hr_adapter_postgres::lifecycle::void::RescindLifecycleEventRequest;
use console_hr_adapter_postgres::notices::{
    AppointmentNoticeListQuery, IssueAppointmentNoticeRequest,
};
use console_kernel_core::BranchScope;
use console_platform_authz::{Feature, Principal};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{Fixture, fixture, status, uuid};

/// A bulk PROMOTE of `n` new employees on `on`: (batch id, event ids).
async fn batch(f: &Fixture, n: usize, on: &str) -> (Uuid, Vec<Uuid>) {
    let mut ids = Vec::new();
    for _ in 0..n {
        ids.push(f.employee().await);
    }
    let body: BulkEmployeeLifecycleEventRequest = serde_json::from_value(json!({
        "event_type": "PROMOTE", "employee_ids": ids, "to_position": "과장",
        "effective_date": on, "comment": "정기 승진"}))
    .unwrap();
    let done =
        f.hr.bulk_lifecycle_events(f.ops.clone(), Uuid::new_v4().to_string(), body)
            .await
            .unwrap();
    let events = done["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| uuid(&i["id"]))
        .collect();
    (uuid(&done["batch_id"]), events)
}

fn notice(extra: Value) -> IssueAppointmentNoticeRequest {
    let mut b = json!({"title": "2026년 10월 정기 인사발령", "notice_date": "2026-10-07"});
    b.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(b).unwrap()
}

async fn issue(
    f: &Fixture,
    who: &Principal,
    body: IssueAppointmentNoticeRequest,
) -> Result<Value, HrError> {
    f.hr.issue_appointment_notice(who.clone(), Some(Uuid::new_v4().to_string()), body)
        .await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn notices_take_gapless_numbers_per_year_and_print_their_lines(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (b1, e1) = batch(&f, 2, "2026-09-01").await;
    let (_, e2) = batch(&f, 1, "2027-03-01").await;
    let first = issue(&f, &f.ops, notice(json!({"batch_id": b1})))
        .await
        .unwrap();
    assert_eq!(first["notice_no"], "2026-0001");
    let lines = first["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0]["line_no"], 1);
    assert_eq!(lines[0]["name"], "한결");
    assert!(e1.contains(&uuid(&lines[0]["event"]["id"])));
    // A reservation is announced too; a new year starts at 0001.
    let second = issue(&f, &f.ops, notice(json!({"event_ids": e2.clone()})))
        .await
        .unwrap();
    assert_eq!(second["notice_no"], "2026-0002");
    assert_eq!(second["lines"][0]["event"]["state"], "SCHEDULED");
    let (_, e3) = batch(&f, 1, "2026-09-02").await;
    let next_year = issue(
        &f,
        &f.ops,
        notice(json!({"event_ids": e3, "notice_date": "2027-01-04"})),
    )
    .await
    .unwrap();
    assert_eq!(next_year["notice_no"], "2027-0001");
    assert_eq!(f.audits("appointment_notice.issue").await, 3);
    // The list is keyset, newest first.
    let page = |cursor: Option<String>| {
        serde_json::from_value::<AppointmentNoticeListQuery>(json!({"limit": 2, "cursor": cursor}))
            .unwrap()
    };
    let one =
        f.hr.appointment_notices(f.ops.clone(), page(None))
            .await
            .unwrap();
    assert_eq!(
        one.items
            .iter()
            .map(|n| n.notice_no.as_str())
            .collect::<Vec<_>>(),
        ["2027-0001", "2026-0002"]
    );
    let two =
        f.hr.appointment_notices(f.ops.clone(), page(one.next_cursor))
            .await
            .unwrap();
    assert_eq!(two.items.len(), 1);
    assert!(two.next_cursor.is_none());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_event_is_announced_once_and_a_refused_notice_takes_no_number(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (b1, e1) = batch(&f, 2, "2026-09-01").await;
    issue(&f, &f.ops, notice(json!({"event_ids": [e1[0]]})))
        .await
        .unwrap();
    let taken = issue(&f, &f.ops, notice(json!({"batch_id": b1})))
        .await
        .unwrap_err();
    assert_eq!(status(&taken), (409, "appointment_notice_event_taken"));
    assert_eq!(taken.refusals.unwrap()[0]["notice_no"], "2026-0001");
    // Shape refusals.
    for bad in [
        notice(json!({})),
        notice(json!({"event_ids": [e1[1]], "batch_id": b1})),
        notice(json!({"event_ids": [e1[1], e1[1]]})),
        // Over the 500-line bound (no lookup is made for any of them).
        notice(json!({"event_ids": (0..501).map(|_| Uuid::new_v4()).collect::<Vec<_>>()})),
    ] {
        assert_eq!(
            status(&issue(&f, &f.ops, bad).await.unwrap_err()),
            (422, "appointment_notice_events_required")
        );
    }
    for bad in [
        notice(json!({"event_ids": [e1[1]], "title": " "})),
        notice(json!({"event_ids": [e1[1]], "notice_date": "2026-02-30"})),
    ] {
        assert_eq!(status(&issue(&f, &f.ops, bad).await.unwrap_err()).0, 422);
    }
    let unknown = issue(&f, &f.ops, notice(json!({"event_ids": [Uuid::new_v4()]})))
        .await
        .unwrap_err();
    assert_eq!(status(&unknown), (404, "not_found"));
    let no_batch = issue(&f, &f.ops, notice(json!({"batch_id": Uuid::new_v4()})))
        .await
        .unwrap_err();
    assert_eq!(status(&no_batch).0, 404);
    // A withdrawn reservation is not a 발령 any more.
    let (b2, e2) = batch(&f, 1, "2027-03-01").await;
    let withdraw: RescindLifecycleEventRequest =
        serde_json::from_value(json!({"reason_code": "PLAN_WITHDRAWN", "confirm_cascades": true}))
            .unwrap();
    f.hr.rescind_lifecycle_batch(f.ops.clone(), b2, withdraw)
        .await
        .unwrap();
    let gone = issue(&f, &f.ops, notice(json!({"event_ids": e2})))
        .await
        .unwrap_err();
    assert_eq!(status(&gone), (409, "appointment_notice_event_ineligible"));
    // Nothing above wrote a notice or consumed a number.
    assert_eq!(f.count("appointment_notices").await, 1);
    assert_eq!(f.audits("appointment_notice.issue").await, 1);
    let next = issue(&f, &f.ops, notice(json!({"event_ids": [e1[1]]})))
        .await
        .unwrap();
    assert_eq!(next["notice_no"], "2026-0002");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn issue_needs_its_key_and_the_manage_gate_and_reads_need_read(pool: PgPool) {
    let f = fixture(pool, true).await;
    let (b1, _) = batch(&f, 1, "2026-09-01").await;
    let missing =
        f.hr.issue_appointment_notice(f.ops.clone(), None, notice(json!({"batch_id": b1})))
            .await
            .unwrap_err();
    assert_eq!(status(&missing).0, 422);
    let key = Uuid::new_v4().to_string();
    let first =
        f.hr.issue_appointment_notice(
            f.ops.clone(),
            Some(key.clone()),
            notice(json!({"batch_id": b1})),
        )
        .await
        .unwrap();
    let replay =
        f.hr.issue_appointment_notice(
            f.ops.clone(),
            Some(key.clone()),
            notice(json!({"batch_id": b1})),
        )
        .await
        .unwrap();
    assert_eq!(first, replay);
    let reused =
        f.hr.issue_appointment_notice(
            f.ops.clone(),
            Some(key),
            notice(json!({"batch_id": b1, "title": "다른 공고"})),
        )
        .await
        .unwrap_err();
    assert_eq!(status(&reused).0, 409);
    assert_eq!(f.count("appointment_notices").await, 1);
    let reader = f
        .granted(Feature::EmployeeDirectoryRead, BranchScope::All)
        .await;
    let (_, e2) = batch(&f, 1, "2026-09-02").await;
    let denied = issue(&f, &reader, notice(json!({"event_ids": e2})))
        .await
        .unwrap_err();
    assert_eq!(status(&denied), (403, "forbidden"));
    assert_eq!(f.count("appointment_notices").await, 1);
    let id = uuid(&first["id"]);
    assert_eq!(
        f.hr.appointment_notice(reader.clone(), id)
            .await
            .unwrap()
            .lines
            .len(),
        1
    );
    let nobody = f.granted(Feature::Login, BranchScope::All).await;
    let hidden = f.hr.appointment_notice(nobody, id).await.unwrap_err();
    assert_eq!(status(&hidden), (403, "forbidden"));
    let elsewhere =
        f.hr.appointment_notice(f.ops.clone(), Uuid::new_v4())
            .await
            .unwrap_err();
    assert_eq!(status(&elsewhere).0, 404);
}

#[path = "notice_candidates.rs"]
mod candidates;
