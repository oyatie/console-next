//! Registry defaults and effective overrides drive every records projection.
use console_attendance_adapter_postgres::{BoardQuery, GridQuery, ScheduleStoreError};
use console_attendance_application::records::PreviewInput;
use console_attendance_domain::records::Mark;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

use super::save::{cell, save, scheduled};
use super::support::{World, key};

const TUE: time::Date = date!(2026 - 10 - 06);

pub(super) async fn seed_override(
    w: &World,
    key: &str,
    scope: Option<Uuid>,
    value: i64,
    future: bool,
) {
    let mut tx = w.owner.begin().await.unwrap();
    // Seed the resolver fixture independently of the already-tested change governance.
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO tenant_setting_overrides
        (org_id,key,scope_entity_id,value,effective_from,set_by,reason_code,direction)
        VALUES ($1,$2,$3,$4,now() + CASE WHEN $6 THEN interval '1 day' ELSE interval '0' END,$5,'X','tighten')")
        .bind(w.org).bind(key).bind(scope).bind(serde_json::json!(value)).bind(w.admin).bind(future)
        .execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
}

async fn preview(w: &World) -> console_attendance_application::records_read::DayRead {
    w.store
        .preview_entries(
            &w.hr(),
            PreviewInput {
                cells: vec![cell(w, 0, TUE, "9:05-18:10")],
            },
        )
        .await
        .unwrap()
        .cells
        .remove(0)
        .after
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn defaults_and_effective_registry_values_drive_preview_save_and_all_reads(owner: PgPool) {
    let w = scheduled(owner).await;
    let old = preview(&w).await;
    assert_eq!(old.marks, vec![Mark::UnapprovedExcess, Mark::Late]);
    assert_eq!(
        (old.recognition.late_unrecognised, old.recognition.late_in),
        (10, 5)
    );
    seed_override(&w, "attendance.excess.notice_minutes", None, 10, false).await;
    seed_override(&w, "attendance.late.grace_minutes", None, 5, false).await;
    let changed = preview(&w).await;
    assert!(changed.marks.is_empty());
    assert_eq!(
        (
            changed.recognition.recognised,
            changed.recognition.late_unrecognised,
            changed.recognition.late_in
        ),
        (
            old.recognition.recognised,
            old.recognition.late_unrecognised,
            old.recognition.late_in
        )
    );
    let (receipt, _) = w
        .store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, TUE, "9:05-18:10")]))
        .await
        .unwrap();
    assert_eq!(receipt.opens.decision, 0);
    let board = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(TUE),
                unit_id: Some(w.team),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let row = board
        .groups
        .iter()
        .flat_map(|g| &g.rows)
        .find(|r| r.employee_id == w.people[0])
        .unwrap();
    assert!(row.day.marks.is_empty());
    let grid = w
        .store
        .month_grid(
            &w.hr(),
            GridQuery {
                month: "2026-10".into(),
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let row = grid
        .rows
        .iter()
        .find(|r| r.employee_id == w.people[0])
        .unwrap();
    assert!(
        row.cells
            .iter()
            .find(|c| c.date == TUE)
            .unwrap()
            .marks
            .is_empty()
    );
    let month = w
        .store
        .person_month(&w.hr(), w.people[0], "2026-10".into())
        .await
        .unwrap();
    assert!(
        month
            .days
            .iter()
            .find(|d| d.date == TUE)
            .unwrap()
            .marks
            .is_empty()
    );
    seed_override(
        &w,
        "attendance.excess.notice_minutes",
        Some(w.entity),
        0,
        false,
    )
    .await;
    seed_override(
        &w,
        "attendance.late.grace_minutes",
        Some(w.entity),
        0,
        false,
    )
    .await;
    seed_override(
        &w,
        "attendance.excess.notice_minutes",
        Some(w.entity),
        30,
        true,
    )
    .await;
    let month = w
        .store
        .person_month(&w.hr(), w.people[0], "2026-10".into())
        .await
        .unwrap();
    assert_eq!(
        month.days.iter().find(|d| d.date == TUE).unwrap().marks,
        old.marks,
        "employer override wins; future value is not in force"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn corrupt_registry_value_refuses_a_save_without_writing_entries(owner: PgPool) {
    let w = scheduled(owner).await;
    seed_override(&w, "attendance.excess.notice_minutes", None, 31, false).await;
    let result = w
        .store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, TUE, "9:05-18:10")]))
        .await;
    assert!(matches!(
        result,
        Err(ScheduleStoreError::Corrupt("attendance thresholds"))
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_entries WHERE org_id=$1")
        .bind(w.org)
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(count, 0, "corruption never falls back or writes");
}
