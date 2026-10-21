//! The typed catalogs, the 직급 PROMOTE, APPOINT and the bulk path (MR-25).

use console_hr_adapter_postgres::lifecycle::requests::BulkEmployeeLifecycleEventRequest;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{event, fixture};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_catalogs_are_typed(pool: PgPool) {
    let f = fixture(pool).await;
    // The same label may live in two lists; a rank only on 직급 and 직위.
    f.entry("GRADE", "책임", Some(3)).await;
    f.entry("POSITION", "책임", None).await;
    let ranked_position = sqlx::query(
        "INSERT INTO job_titles (org_id, kind, label, grade_rank, created_by) VALUES ($1, 'POSITION', '팀장', 5, $2)",
    )
    .bind(f.org)
    .bind(f.user)
    .execute(&f.owner)
    .await
    .unwrap_err();
    assert_eq!(
        ranked_position
            .as_database_error()
            .unwrap()
            .code()
            .as_deref(),
        Some("23514")
    );
    let query = serde_json::from_value(json!({"kind": "grade"})).unwrap();
    let grades =
        f.hr.job_titles(f.principal.clone(), query)
            .await
            .unwrap()
            .items;
    assert_eq!(
        grades.iter().map(|t| t.kind.as_str()).collect::<Vec<_>>(),
        ["GRADE"]
    );
    // An id of another kind never lands in a classification column.
    let title = f.entry("TITLE", "과장", Some(5)).await;
    let employee = f.employee(None).await;
    let wrong = sqlx::query("UPDATE employees SET grade_id = $2 WHERE id = $1")
        .bind(employee)
        .bind(title)
        .execute(&f.owner)
        .await
        .unwrap_err();
    assert_eq!(
        wrong.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_grade_promotion_is_dated_checked_and_rescinded(pool: PgPool) {
    let f = fixture(pool).await;
    let (low, high) = (
        f.entry("GRADE", "G3", Some(3)).await,
        f.entry("GRADE", "G5", Some(5)).await,
    );
    let title = f.entry("TITLE", "과장", Some(5)).await;
    let e = f.employee(None).await;
    let wrong_kind = f
        .record(
            e,
            event("PROMOTE", "2026-09-01", json!({"to_grade_id": title})),
        )
        .await;
    assert_eq!(
        wrong_kind.unwrap_err(),
        (422, "job_title_unknown".to_owned())
    );
    f.record(
        e,
        event("PROMOTE", "2026-09-01", json!({"to_grade_id": high})),
    )
    .await
    .unwrap();
    assert_eq!(f.head(e).await.0, Some(high));
    let down = |reason: Value| {
        event(
            "PROMOTE",
            "2026-09-02",
            json!({"to_grade_id": low, "reason_code": reason}),
        )
    };
    assert_eq!(
        f.record(e, down(Value::Null)).await.unwrap_err(),
        (422, "demotion_reason_required".to_owned())
    );
    let demoted = f
        .record(e, down(json!("DISCIPLINARY_DEMOTION")))
        .await
        .unwrap();
    assert_eq!(
        (
            demoted["from_grade_id"].as_str(),
            demoted["to_grade_id"].as_str()
        ),
        (Some(&*high.to_string()), Some(&*low.to_string()))
    );
    // A 직급-only PROMOTE keeps the 직위 text.
    assert_eq!(demoted["to_position"], "사원");
    f.rescind(e, &demoted).await;
    assert_eq!(f.head(e).await.0, Some(high));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_appointment_sets_position_job_and_family_and_is_undone(pool: PgPool) {
    let f = fixture(pool).await;
    let lead = f.entry("POSITION", "팀장", None).await;
    let hr_job = f.entry("JOB", "인사", None).await;
    let family = f.entry("JOB_FAMILY", "관리직", None).await;
    let e = f.employee(None).await;
    let appointed = f
        .record(e, event("APPOINT", "2026-09-01", json!({"to_position_kind_id": lead, "to_job_id": hr_job, "to_job_family_id": family})))
        .await
        .unwrap();
    assert_eq!(appointed["to_job"], "인사");
    assert_eq!(appointed["from_job"], "생산");
    assert_eq!(
        f.head(e).await,
        (
            None,
            Some(lead),
            Some(hr_job),
            Some("인사".to_owned()),
            Some(family)
        )
    );
    let again = f
        .record(
            e,
            event(
                "APPOINT",
                "2026-09-02",
                json!({"to_position_kind_id": lead}),
            ),
        )
        .await;
    assert_eq!(again.unwrap_err(), (422, "lifecycle_noop".to_owned()));
    let vacated = f
        .record(
            e,
            event(
                "APPOINT",
                "2026-09-02",
                json!({"vacate_position_kind": true}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(f.head(e).await.1, None);
    f.rescind(e, &vacated).await;
    assert_eq!(f.head(e).await.1, Some(lead));
    f.rescind(e, &appointed).await;
    assert_eq!(
        f.head(e).await,
        (None, None, None, Some("생산".to_owned()), None)
    );
    // An APPOINT field on another event is refused.
    let stray = f
        .record(
            e,
            event("TRANSFER", "2026-09-03", json!({"to_job_id": hr_job})),
        )
        .await;
    assert_eq!(stray.unwrap_err().0, 422);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bulk_appointment_moves_everyone_or_no_one(pool: PgPool) {
    let f = fixture(pool).await;
    let job = f.entry("JOB", "품질", None).await;
    let (a, b) = (f.employee(None).await, f.employee(Some("REGULAR")).await);
    let body = |ids: Vec<Uuid>| -> BulkEmployeeLifecycleEventRequest {
        serde_json::from_value(
            json!({"event_type": "APPOINT", "employee_ids": ids, "to_job_id": job,
            "effective_date": "2026-09-01", "comment": "bulk"}),
        )
        .unwrap()
    };
    let p = || f.principal.clone();
    let key = || Uuid::new_v4().to_string();
    f.hr.bulk_lifecycle_events(p(), key(), body(vec![a, b]))
        .await
        .unwrap();
    assert_eq!(
        (f.head(a).await.2, f.head(b).await.2),
        (Some(job), Some(job))
    );
    let refused =
        f.hr.bulk_lifecycle_events(p(), key(), body(vec![a]))
            .await
            .unwrap_err();
    assert_eq!(refused.code, "bulk_lifecycle_refused");
    let types: BulkEmployeeLifecycleEventRequest = serde_json::from_value(json!({
        "event_type": "EMPLOYMENT_TYPE_CHANGE", "employee_ids": [b], "to_employment_type": "PART_TIME",
        "effective_date": "2026-09-02", "comment": "bulk"}))
    .unwrap();
    f.hr.bulk_lifecycle_events(p(), key(), types).await.unwrap();
    assert_eq!(f.employment(b).await.0, "PART_TIME");
}
