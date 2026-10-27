//! Long records preserve evidence only after a cell-bound acknowledgement.
use console_attendance_adapter_postgres::ScheduleStoreError;
use console_attendance_application::records::{CorrectInput, PreviewInput};
use console_attendance_domain::schedule::Window;
use serde_json::Value;
use sqlx::PgPool;
use time::macros::date;

use super::save::{cell, paper, save, scheduled};
use super::support::{key, rows};
use super::thresholds::seed_override;

const TUE: time::Date = date!(2026 - 10 - 06);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unconfirmed_long_span_refuses_the_whole_batch_confirmed_span_is_recorded_and_audited(
    owner: PgPool,
) {
    let w = scheduled(owner).await;
    let mut long = cell(&w, 0, TUE, "5-23");
    let preview = w
        .store
        .preview_entries(
            &w.hr(),
            PreviewInput {
                cells: vec![long.clone()],
            },
        )
        .await
        .unwrap();
    assert_eq!(preview.cells[0].code, Some("span_too_long"));
    assert_eq!(preview.cells[0].long_span_minutes, Some(960));
    assert!(preview.cells[0].after.is_none());
    let result = w
        .store
        .save_entries(
            &w.hr(),
            &key(),
            save(vec![long.clone(), cell(&w, 1, TUE, "9-18")]),
        )
        .await;
    match result {
        Err(ScheduleStoreError::CellsRefused(cells)) => {
            assert_eq!(cells[0].code, Some("span_too_long"))
        }
        other => panic!("expected refusal, got {other:?}"),
    }
    assert_eq!(rows(&w, "attendance_entries").await, 0);
    assert_eq!(rows(&w, "attendance_batches").await, 0);
    long.long_span_confirmed = true;
    let (receipt, fresh) = w
        .store
        .save_entries(&w.hr(), &key(), save(vec![long]))
        .await
        .unwrap();
    assert!(fresh);
    assert_eq!(receipt.saved, 1);
    let month = w
        .store
        .person_month(&w.hr(), w.people[0], "2026-10".into())
        .await
        .unwrap();
    assert_eq!(
        month.history[0].entry.segments,
        vec![Window {
            start: 300,
            end: 1380
        }]
    );
    let rec = month
        .days
        .iter()
        .find(|d| d.date == TUE)
        .unwrap()
        .recognition;
    assert_eq!(
        (rec.recorded, rec.recognised, rec.approved),
        (1080, 1020, 0)
    );
    let snap: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='attendance.entries.save'",
    )
    .bind(w.org)
    .fetch_one(&w.owner)
    .await
    .unwrap();
    assert_eq!(
        snap["long_span_confirmations"][0]["employee_id"],
        w.people[0].to_string()
    );
    assert_eq!(
        snap["long_span_confirmations"][0]["work_date"],
        TUE.to_string()
    );
    assert_eq!(snap["long_span_confirmations"][0]["threshold_minutes"], 960);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn correction_uses_the_same_confirmation_guard_and_preserves_history(owner: PgPool) {
    let w = scheduled(owner).await;
    w.store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, TUE, "9-18")]))
        .await
        .unwrap();
    let id = w
        .store
        .person_month(&w.hr(), w.people[0], "2026-10".into())
        .await
        .unwrap()
        .history[0]
        .entry
        .id;
    let correction = |confirmed| CorrectInput {
        value: "5-23".into(),
        long_span_confirmed: confirmed,
        reason: "Source checked".into(),
        evidence: paper(),
    };
    let result = w
        .store
        .correct_entry(&w.hr(), &key(), id, correction(false))
        .await;
    assert!(
        matches!(result, Err(ScheduleStoreError::CellsRefused(ref cells)) if cells[0].code == Some("span_too_long"))
    );
    assert_eq!(rows(&w, "attendance_entries").await, 1);
    w.store
        .correct_entry(&w.hr(), &key(), id, correction(true))
        .await
        .unwrap();
    let month = w
        .store
        .person_month(&w.hr(), w.people[0], "2026-10".into())
        .await
        .unwrap();
    assert_eq!(month.history.len(), 2);
    assert_eq!(month.history[0].entry.supersedes_id, Some(id));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn effective_employer_policy_wins_and_corrupt_policy_fails_closed_even_with_confirmation(
    owner: PgPool,
) {
    let w = scheduled(owner).await;
    let policy = "attendance.entry.long_span_confirm_minutes";
    seed_override(&w, policy, None, 480, false).await;
    let input = || PreviewInput {
        cells: vec![cell(&w, 0, TUE, "9-18")],
    };
    let preview = w.store.preview_entries(&w.hr(), input()).await.unwrap();
    assert_eq!(preview.cells[0].code, Some("span_too_long"));
    assert_eq!(preview.cells[0].long_span_minutes, Some(480));
    seed_override(&w, policy, Some(w.entity), 600, false).await;
    seed_override(&w, policy, Some(w.entity), 1, true).await;
    let preview = w.store.preview_entries(&w.hr(), input()).await.unwrap();
    assert_eq!(preview.ok, 1);
    assert_eq!(preview.cells[0].long_span_minutes, Some(600));
    seed_override(&w, policy, Some(w.entity), 0, false).await;
    let mut confirmed = cell(&w, 0, TUE, "9-18");
    confirmed.long_span_confirmed = true;
    let result = w
        .store
        .save_entries(&w.hr(), &key(), save(vec![confirmed]))
        .await;
    assert!(matches!(
        result,
        Err(ScheduleStoreError::Corrupt("attendance thresholds"))
    ));
    assert_eq!(rows(&w, "attendance_entries").await, 0);
}
