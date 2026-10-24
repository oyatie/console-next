// SPDX-License-Identifier: LicenseRef-Proprietary
//! Register changes affect new judgments, never reads of saved patterns.

use super::support::{assign, future, key, office, refused, rows, today, world};
use console_attendance_domain::schedule::Level;
use sqlx::PgPool;
use time::Duration;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn saved_patterns_stay_readable_after_break_floors_tighten_or_expire(owner: PgPool) {
    let w = world(owner).await;
    let (saved, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("사무"))
        .await
        .unwrap();
    sqlx::query(
        "UPDATE attendance_break_floors SET rest_minutes = rest_minutes + 15 WHERE NOT waiver",
    )
    .execute(&w.owner)
    .await
    .unwrap();
    let listed = w.store.list_patterns(&w.hr(), false).await.unwrap();
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].id, saved.id);
    assert_eq!(listed.items[0].night_work, saved.night_work);
    // Leave rows in the register, but none in force today.
    sqlx::query("UPDATE attendance_break_floors SET effective_from = GREATEST($1, enforced_on), effective_to_exclusive = NULL")
        .bind(future()).execute(&w.owner).await.unwrap();
    assert_eq!(
        w.store.list_patterns(&w.hr(), false).await.unwrap().items[0].id,
        saved.id
    );
    assert_eq!(
        w.store
            .retire_pattern(&w.hr(), saved.id)
            .await
            .unwrap()
            .status,
        "RETIRED"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn assignments_judge_break_floors_on_the_layer_start_or_today(owner: PgPool) {
    let w = world(owner).await;
    let (saved, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("사무"))
        .await
        .unwrap();
    let from = future();
    sqlx::query("UPDATE attendance_break_floors SET effective_to_exclusive = $1 WHERE NOT waiver")
        .bind(from)
        .execute(&w.owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO attendance_break_floors (code, effective_from, work_minutes, rest_minutes, waiver, \
         instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko) \
         SELECT code, $1, work_minutes, rest_minutes + 15, waiver, instrument_ko, article_ko, \
         promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko \
         FROM attendance_break_floors WHERE NOT waiver AND effective_to_exclusive = $1"
    ).bind(from).execute(&w.owner).await.unwrap();
    for on in [
        today() - Duration::days(1),
        today(),
        from - Duration::days(1),
    ] {
        let preview = w
            .store
            .preview_schedule(
                &w.hr(),
                assign(Level::Workplace, w.workplaces[0], saved.id, on),
            )
            .await
            .unwrap();
        assert!(preview.refusals.is_empty());
    }
    let input = assign(Level::Workplace, w.workplaces[0], saved.id, from);
    assert_eq!(
        refused(
            w.store
                .preview_schedule(&w.hr(), input.clone())
                .await
                .unwrap_err()
        ),
        "break_below_minimum"
    );
    assert_eq!(
        refused(
            w.store
                .assign_schedule(&w.hr(), &key(), input)
                .await
                .unwrap_err()
        ),
        "break_below_minimum"
    );
    assert_eq!(rows(&w, "attendance_schedule_layers").await, 0);

    // Historical starts still judge today, even if an old row was lenient.
    sqlx::query("UPDATE attendance_break_floors SET effective_to_exclusive = $1 WHERE NOT waiver AND effective_to_exclusive = $2")
        .bind(today()).bind(from).execute(&w.owner).await.unwrap();
    sqlx::query(
        "INSERT INTO attendance_break_floors (code, effective_from, effective_to_exclusive, work_minutes, rest_minutes, waiver, \
         instrument_ko, article_ko, promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko) \
         SELECT code, $1, $2, work_minutes, rest_minutes + 15, waiver, instrument_ko, article_ko, \
         promulgation_ko, enforced_on, source_url, retrieved_on, provenance_ko \
         FROM attendance_break_floors WHERE NOT waiver AND effective_to_exclusive = $1"
    ).bind(today()).bind(from).execute(&w.owner).await.unwrap();
    let past = assign(
        Level::Workplace,
        w.workplaces[0],
        saved.id,
        today() - Duration::days(1),
    );
    assert_eq!(
        refused(w.store.preview_schedule(&w.hr(), past).await.unwrap_err()),
        "break_below_minimum"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_dated_break_floors_refuse_pattern_creation_without_writing(owner: PgPool) {
    let w = world(owner).await;
    sqlx::query("UPDATE attendance_break_floors SET effective_from = GREATEST($1, enforced_on), effective_to_exclusive = NULL")
        .bind(future()).execute(&w.owner).await.unwrap();
    assert_eq!(
        refused(
            w.store
                .create_pattern(&w.hr(), &key(), office("사무"))
                .await
                .unwrap_err()
        ),
        "break_floor_not_in_force"
    );
    assert_eq!(rows(&w, "attendance_work_patterns").await, 0);
}
