// SPDX-License-Identifier: LicenseRef-Proprietary
use console_attendance_adapter_postgres::ScheduleStoreError;
use console_attendance_application::records::PreviewInput;
use console_attendance_domain::schedule::Level;
use serde_json::json;
use sqlx::PgPool;
use time::macros::date;

use super::save::{cell, save, scheduled};
use super::support::{assign, key, office, rows, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reserved_words_preview_and_save_their_meaning_on_colliding_slots(owner: PgPool) {
    let w = world(owner).await;
    let date = date!(2026 - 10 - 06);
    let mut pattern = office("입력 구분");
    pattern.kind = "ROTATION".into();
    pattern.days = None;
    pattern.slots = Some(json!([
        {"code": "X", "day": {"kind": "WORK", "shift": {"start": 540, "end": 1020, "breaks": [{"start": 720, "end": 780}]}}},
        {"code": "결", "day": {"kind": "WORK", "shift": {"start": 540, "end": 1020, "breaks": [{"start": 720, "end": 780}]}}},
        {"code": "외", "day": {"kind": "WORK", "shift": {"start": 540, "end": 1020, "breaks": [{"start": 720, "end": 780}]}}},
        {"code": "O", "day": {"kind": "WEEKLY_HOLIDAY"}}
    ]));
    let (pattern, _) = w
        .store
        .create_pattern(&w.hr(), &key(), pattern)
        .await
        .unwrap();
    let mut assignment = assign(Level::Workplace, w.workplaces[0], pattern.id, date);
    assignment.targets[0].rotation_start = Some(date);
    w.store
        .assign_schedule(&w.hr(), &key(), assignment)
        .await
        .unwrap();
    for (offset, raw, kind) in [
        (0, "ｘ", "ABSENT"),
        (1, "결", "ABSENT"),
        (2, "외", "OUTSIDE_WORK"),
        (3, "o", "OUTSIDE_WORK"),
    ] {
        let day = date + time::Duration::days(offset);
        let cells = vec![cell(&w, 0, day, raw)];
        let preview = w
            .store
            .preview_entries(
                &w.hr(),
                PreviewInput {
                    cells: cells.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!((preview.ok, preview.refused), (1, 0), "{raw}");
        let after = preview.cells[0].after.as_ref().unwrap();
        let entry = after.entry.as_ref().unwrap();
        assert_eq!(entry.kind.as_str(), kind, "{raw}");
        assert!(entry.segments.is_empty(), "{raw}");
        w.store
            .save_entries(&w.hr(), &key(), save(cells))
            .await
            .unwrap();
        let stored: (String, i64) = sqlx::query_as(
            "SELECT kind, jsonb_array_length(segments)::bigint FROM attendance_entries WHERE employee_id = $1 AND work_date = $2",
        ).bind(w.people[0]).bind(day).fetch_one(&w.owner).await.unwrap();
        assert_eq!(stored, (kind.into(), 0), "{raw}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_slot_codes_preview_and_save_the_planned_shift(owner: PgPool) {
    let w = world(owner).await;
    let date = date!(2026 - 10 - 06);
    let mut pattern = office("교대");
    pattern.kind = "ROTATION".into();
    pattern.days = None;
    pattern.slots = Some(json!([
        {"code": "G1", "day": {"kind": "WORK", "shift": {"start": 540, "end": 1080, "breaks": [{"start": 720, "end": 780}]}}},
        {"code": "R", "day": {"kind": "WEEKLY_HOLIDAY"}}
    ]));
    let (pattern, _) = w
        .store
        .create_pattern(&w.hr(), &key(), pattern)
        .await
        .unwrap();
    let mut assignment = assign(Level::Workplace, w.workplaces[0], pattern.id, date);
    assignment.targets[0].rotation_start = Some(date);
    w.store
        .assign_schedule(&w.hr(), &key(), assignment)
        .await
        .unwrap();
    let preview = w
        .store
        .preview_entries(
            &w.hr(),
            PreviewInput {
                cells: vec![cell(&w, 0, date, "ｇ１"), cell(&w, 1, date, "A")],
            },
        )
        .await
        .unwrap();
    assert_eq!((preview.ok, preview.refused), (1, 1));
    assert_eq!(preview.cells[1].code, Some("schedule_change_needed"));
    assert_eq!(
        preview.cells[0]
            .after
            .as_ref()
            .unwrap()
            .recognition
            .recorded,
        540
    );
    let (receipt, _) = w
        .store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, date, "G1")]))
        .await
        .unwrap();
    assert_eq!(receipt.saved, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn grammar_refusals_reach_preview_and_save_without_writing(owner: PgPool) {
    let w = scheduled(owner).await;
    for (raw, expected) in [
        ("지각", "status_is_derived"),
        ("8", "hours_without_times"),
        ("0.375", "excel_fraction"),
        ("출", "code_ambiguous"),
        ("휴", "schedule_change_needed"),
        ("-18", "clock_out_only_not_stored"),
        ("연차", "leave_not_stored"),
        ("재택 9-18", "activity_not_stored"),
    ] {
        let cells = vec![cell(&w, 0, date!(2026 - 10 - 06), raw)];
        let preview = w
            .store
            .preview_entries(
                &w.hr(),
                PreviewInput {
                    cells: cells.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(preview.cells[0].code, Some(expected), "{raw}");
        match w
            .store
            .save_entries(&w.hr(), &key(), save(cells))
            .await
            .unwrap_err()
        {
            ScheduleStoreError::CellsRefused(cells) => assert_eq!(cells[0].code, Some(expected)),
            other => panic!("unexpected {other:?}"),
        }
    }
    let preview = w
        .store
        .preview_entries(
            &w.hr(),
            PreviewInput {
                cells: vec![cell(&w, 0, date!(2026 - 10 - 10), "휴")],
            },
        )
        .await
        .unwrap();
    assert_eq!(preview.cells[0].code, Some("already_day_off"));
    assert_eq!(rows(&w, "attendance_entries").await, 0);
}
