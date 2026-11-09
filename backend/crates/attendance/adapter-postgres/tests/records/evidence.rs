// SPDX-License-Identifier: LicenseRef-Proprietary
use console_attendance_application::records::{CorrectInput, Evidence, VoidInput};
use sqlx::PgPool;
use time::macros::date;

use super::save::{cell, save, scheduled};
use super::support::{TestReads, key};

fn work_output() -> Evidence {
    serde_json::from_value(serde_json::json!({"kind": "WORK_OUTPUT", "note": "작업 기록 대조"}))
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn work_output_is_kept_on_save_correction_void_and_history(owner: PgPool) {
    let w = scheduled(owner).await;
    let hr = w.hr();
    let mut input = save(vec![cell(&w, 0, date!(2026 - 10 - 06), "9-20")]);
    input.evidence = work_output();
    w.store.save_entries(&hr, &key(), input).await.unwrap();
    let month = w
        .store
        .person_month(&hr, w.people[0], "2026-10".into())
        .await
        .unwrap();
    let first = month.history[0].entry.id;
    assert_eq!(month.history[0].entry.evidence_kind, "WORK_OUTPUT");
    w.store
        .correct_entry(
            &hr,
            &key(),
            first,
            CorrectInput {
                value: "9-19".into(),
                long_span_confirmed: false,
                reason: "작업 기록과 대조".into(),
                evidence: work_output(),
            },
        )
        .await
        .unwrap();
    let month = w
        .store
        .person_month(&hr, w.people[0], "2026-10".into())
        .await
        .unwrap();
    let current = month.history[0].entry.id;
    assert_eq!(month.history[0].entry.supersedes_id, Some(first));
    w.store
        .void_entry(
            &hr,
            &key(),
            current,
            VoidInput {
                reason: "다른 사람 기록".into(),
                evidence: work_output(),
            },
        )
        .await
        .unwrap();
    let month = w
        .store
        .person_month(&hr, w.people[0], "2026-10".into())
        .await
        .unwrap();
    assert_eq!(month.history.len(), 3);
    assert!(
        month
            .history
            .iter()
            .all(|h| h.entry.evidence_kind == "WORK_OUTPUT")
    );
    let batches: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_batches WHERE org_id=$1 AND evidence_kind='WORK_OUTPUT' AND evidence_note='작업 기록 대조'")
        .bind(w.org).fetch_one(&w.owner).await.unwrap();
    assert_eq!(batches, 3);
}
