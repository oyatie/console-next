//! Saving cells: one transaction, recognition on read, every refusal saves nothing.

use console_attendance_adapter_postgres::{BoardQuery, GridQuery, ScheduleStoreError};
use console_attendance_application::records::{
    CellInput, EntrySource, Evidence, EvidenceKind, PreviewInput, SaveInput,
};
use console_attendance_domain::records::Mark;
use console_attendance_domain::schedule::Level;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

use super::support::{World, assign, code, key, office, rows, today, world};

pub fn cell(w: &World, who: usize, d: time::Date, value: &str) -> CellInput {
    CellInput {
        employee_id: w.people[who],
        work_date: d,
        value: value.into(),
        long_span_confirmed: false,
        base_entry_id: None,
    }
}

pub fn paper() -> Evidence {
    Evidence {
        kind: EvidenceKind::PaperSheet,
        note: None,
        confirmer_employee_id: None,
    }
}

pub fn save(cells: Vec<CellInput>) -> SaveInput {
    SaveInput {
        cells,
        source: EntrySource::Manual,
        evidence: paper(),
    }
}

/// 주 5일 09–18 at 평택 from 2026-01-01.
pub async fn scheduled(owner: PgPool) -> World {
    let w = world(owner).await;
    let (p, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("사무"))
        .await
        .unwrap();
    w.store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(
                Level::Workplace,
                w.workplaces[0],
                p.id,
                date!(2026 - 01 - 01),
            ),
        )
        .await
        .unwrap();
    w
}

const TUE: time::Date = date!(2026 - 10 - 06);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_stay_is_recorded_but_only_the_schedule_is_recognised(owner: PgPool) {
    let w = scheduled(owner).await;
    let preview = w
        .store
        .preview_entries(
            &w.hr(),
            PreviewInput {
                cells: vec![cell(&w, 0, TUE, "8:52-19:10"), cell(&w, 1, TUE, "+2")],
            },
        )
        .await
        .unwrap();
    assert_eq!((preview.ok, preview.refused), (1, 1));
    assert_eq!(preview.cells[1].code, Some("overtime_typed"));
    let after = preview.cells[0].after.as_ref().unwrap();
    assert_eq!(
        (
            after.recognition.recognised,
            after.recognition.early_unrecognised,
            after.recognition.late_unrecognised
        ),
        (480, 8, 70)
    );
    assert_eq!(after.marks, vec![Mark::UnapprovedExcess]);

    let (receipt, fresh) = w
        .store
        .save_entries(
            &w.hr(),
            &key(),
            save(vec![cell(&w, 0, TUE, "8:52-19:10"), cell(&w, 1, TUE, "=")]),
        )
        .await
        .unwrap();
    assert!(fresh);
    assert_eq!(
        (
            receipt.saved,
            receipt.opens.decision,
            receipt.closes.blocking
        ),
        (2, 1, 2),
        "two 미기록 close, one 잔류 opens"
    );
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
    assert_eq!(
        (
            row.totals.recognised,
            row.totals.unrecognised,
            row.totals.decision
        ),
        (480, 78, 1)
    );
    assert!(
        row.totals.blocking > 0,
        "the other past work days of October are 미기록"
    );

    let board = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(TUE),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let l = board.ledger;
    assert_eq!(l.people, 3);
    assert_eq!(
        l.people,
        l.no_schedule
            + l.rest
            + l.no_record
            + l.missing_out
            + l.absent
            + l.outside
            + l.trip
            + l.late_or_early
            + l.normal
            + l.pending
    );
    assert_eq!((l.normal, l.no_schedule), (2, 1), "서울 has no 근무 일정");
    let month = w
        .store
        .person_month(&w.hr(), w.people[0], "2026-10".into())
        .await
        .unwrap();
    assert!(month.provisional);
    assert_eq!(month.history.len(), 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_cell_refusal_saves_nothing(owner: PgPool) {
    let w = scheduled(owner).await;
    let hr = w.hr();
    let refused = |r: Result<_, ScheduleStoreError>| match r {
        Err(ScheduleStoreError::CellsRefused(cells)) => cells
            .into_iter()
            .map(|c| c.code.unwrap())
            .collect::<Vec<_>>(),
        Err(e) => panic!("{e:?}"),
        Ok(v) => panic!("saved {v:?}"),
    };
    let sunday = date!(2026 - 10 - 04);
    let future = today() + time::Duration::days(30);
    let stranger = CellInput {
        employee_id: Uuid::new_v4(),
        work_date: TUE,
        value: "9-18".into(),
        long_span_confirmed: false,
        base_entry_id: None,
    };
    let codes = refused(
        w.store
            .save_entries(
                &hr,
                &key(),
                save(vec![
                    cell(&w, 0, TUE, "18+2"),
                    cell(&w, 1, sunday, "="),
                    cell(&w, 0, future, "9-18"),
                    stranger,
                    cell(&w, 1, TUE, "7:48-5:10"),
                    cell(&w, 1, date!(2026 - 10 - 07), "5-23"),
                    cell(&w, 1, date!(2026 - 10 - 08), "9-13,12-18"),
                    cell(&w, 0, date!(2026 - 10 - 01), "6:5O-16"),
                ]),
            )
            .await,
    );
    assert_eq!(
        codes,
        vec![
            "overtime_typed",
            "no_shift_to_copy",
            "future_date",
            "not_on_roster",
            "overnight_without_marker",
            "span_too_long",
            "spans_overlap",
            "entry_unreadable"
        ]
    );
    // A planned 출장 for a future day is allowed.
    w.store
        .save_entries(&hr, &key(), save(vec![cell(&w, 0, future, "출장")]))
        .await
        .unwrap();

    sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2")
        .bind(w.people[1])
        .bind(w.admin)
        .execute(&w.owner)
        .await
        .unwrap();
    assert_eq!(
        refused(
            w.store
                .save_entries(&hr, &key(), save(vec![cell(&w, 1, TUE, "9-18")]))
                .await
        ),
        vec!["own_row"]
    );
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, branch_id, checks, attested_by) VALUES ($1, '2026-09-01', $2, '{}', $3)")
        .bind(w.org).bind(w.branches[0]).bind(w.admin).execute(&w.owner).await.unwrap();
    assert_eq!(
        refused(
            w.store
                .save_entries(
                    &hr,
                    &key(),
                    save(vec![cell(&w, 0, date!(2026 - 09 - 15), "9-18")])
                )
                .await
        ),
        vec!["entry_month_closed"]
    );

    assert_eq!(
        code(w.store.save_entries(&hr, &key(), save(vec![])).await),
        "nothing_to_save"
    );
    let many: Vec<_> = (0..10_001).map(|_| cell(&w, 0, TUE, "9-18")).collect();
    assert_eq!(
        code(w.store.save_entries(&hr, &key(), save(many)).await),
        "batch_too_large"
    );
    let mut confirm = save(vec![cell(&w, 0, TUE, "9-18")]);
    confirm.evidence.kind = EvidenceKind::SupervisorConfirm;
    assert_eq!(
        code(w.store.save_entries(&hr, &key(), confirm).await),
        "evidence_confirmer_required"
    );
    assert_eq!(
        rows(&w, "attendance_entries").await,
        1,
        "only the planned 출장"
    );
}
