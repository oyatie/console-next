//! RLS and a lower branch grant cannot read or mutate live S2 records.
use super::save::{cell, paper, save, scheduled};
use super::security_support::business;
use super::support::{code, key};
use console_attendance_adapter_postgres::{BoardQuery, GridQuery};
use console_attendance_application::CallerScope;
use console_attendance_application::records::{CorrectInput, PreviewInput, UndoInput, VoidInput};
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn different_tenant_and_lower_scope_refuse_all_record_operations(owner: PgPool) {
    let w = scheduled(owner.clone()).await;
    let date = date!(2026 - 10 - 06);
    let (receipt, _) = w
        .store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, date, "9-18")]))
        .await
        .unwrap();
    let entry = w
        .store
        .person_month(&w.hr(), w.people[0], "2026-10".into())
        .await
        .unwrap()
        .history[0]
        .entry
        .id;
    let foreign_org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'foreign-records')")
        .bind(foreign_org)
        .bind(format!("s2-{}", &foreign_org.simple().to_string()[..12]))
        .execute(&owner)
        .await
        .unwrap();
    let foreign = CallerScope {
        org_id: foreign_org,
        user_id: Uuid::new_v4(),
        branch_ids: vec![],
        org_wide: true,
    };
    for (caller, missing, entry_missing, batch_missing) in [
        (
            foreign,
            "scope_not_found",
            "entry_not_found",
            "batch_not_found",
        ),
        (w.seoul_hr(), "forbidden", "forbidden", "forbidden"),
    ] {
        let before = business(&owner).await;
        assert_eq!(
            code(
                w.store
                    .day_board(
                        &caller,
                        BoardQuery {
                            date: Some(date),
                            workplace_id: Some(w.workplaces[0]),
                            ..Default::default()
                        }
                    )
                    .await
            ),
            missing
        );
        assert_eq!(business(&owner).await, before);
        assert_eq!(
            code(
                w.store
                    .month_grid(
                        &caller,
                        GridQuery {
                            month: "2026-10".into(),
                            workplace_id: Some(w.workplaces[0]),
                            limit: 100,
                            ..Default::default()
                        }
                    )
                    .await
            ),
            missing
        );
        assert_eq!(business(&owner).await, before);
        assert_eq!(
            code(
                w.store
                    .person_month(&caller, w.people[0], "2026-10".into())
                    .await
            ),
            missing
        );
        assert_eq!(business(&owner).await, before);
        let cells = vec![cell(&w, 1, date, "9-18")];
        let preview = w
            .store
            .preview_entries(
                &caller,
                PreviewInput {
                    cells: cells.clone(),
                },
            )
            .await;
        if caller.org_id == foreign_org {
            let preview = preview.unwrap();
            assert_eq!(preview.cells[0].code, Some("not_on_roster"));
            assert!(preview.cells[0].after.is_none());
            let refusal = w
                .store
                .save_entries(&caller, &key(), save(cells))
                .await
                .unwrap_err();
            assert_eq!(refusal.to_string(), "cells_refused");
            assert!(
                matches!(refusal, console_attendance_adapter_postgres::ScheduleStoreError::CellsRefused(cells)
                if cells.len() == 1 && cells[0].code == Some("not_on_roster"))
            );
        } else {
            assert_eq!(code(preview), "forbidden");
            assert_eq!(
                code(w.store.save_entries(&caller, &key(), save(cells)).await),
                "forbidden"
            );
        }
        assert_eq!(business(&owner).await, before);
        assert_eq!(
            code(
                w.store
                    .correct_entry(
                        &caller,
                        &key(),
                        entry,
                        CorrectInput {
                            value: "9-17".into(),
                            long_span_confirmed: false,
                            reason: "scope test".into(),
                            evidence: paper()
                        }
                    )
                    .await
            ),
            entry_missing
        );
        assert_eq!(business(&owner).await, before);
        assert_eq!(
            code(
                w.store
                    .void_entry(
                        &caller,
                        &key(),
                        entry,
                        VoidInput {
                            reason: "scope test".into(),
                            evidence: paper()
                        }
                    )
                    .await
            ),
            entry_missing
        );
        assert_eq!(business(&owner).await, before);
        assert_eq!(
            code(
                w.store
                    .undo_batch(
                        &caller,
                        receipt.batch_id,
                        UndoInput {
                            reason: "scope test".into()
                        }
                    )
                    .await
            ),
            batch_missing
        );
        assert_eq!(business(&owner).await, before);
    }
    // An unfiltered read filters rows before returning them, with populated foreign data present.
    let lower = w.seoul_hr();
    let month = w
        .store
        .month_grid(
            &lower,
            GridQuery {
                month: "2026-10".into(),
                limit: 100,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(month.rows.iter().all(|r| r.employee_id == w.people[2]));
    let board = w
        .store
        .day_board(
            &lower,
            BoardQuery {
                date: Some(date),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(
        board
            .groups
            .iter()
            .all(|g| g.workplace_id == Some(w.workplaces[1]))
    );
}
