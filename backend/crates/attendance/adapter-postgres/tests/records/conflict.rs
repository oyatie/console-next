//! A changed base is a conflict that names both values; a replay is the same save.

use console_attendance_adapter_postgres::ScheduleStoreError;
use sqlx::PgPool;
use time::macros::date;

use super::save::{cell, save, scheduled};
use super::support::{code, key, rows};

const TUE: time::Date = date!(2026 - 10 - 06);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_changed_base_is_a_conflict_with_both_values(owner: PgPool) {
    let w = scheduled(owner).await;
    let (first, _) = w
        .store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, TUE, "9-18")]))
        .await
        .unwrap();
    // A second typist still saw the day empty.
    match w
        .store
        .save_entries(&w.hr(), &key(), save(vec![cell(&w, 0, TUE, "9-17")]))
        .await
    {
        Err(ScheduleStoreError::EntryConflict(c)) => {
            assert_eq!(
                (c.len(), c[0].mine.as_str(), c[0].base_entry_id),
                (1, "9-17", None)
            );
            assert_eq!(c[0].current.as_ref().unwrap().batch_id, first.batch_id);
        }
        other => panic!("{other:?}"),
    }
    let k = key();
    let replay = save(vec![cell(&w, 1, TUE, "9-18")]);
    let (a, _) = w
        .store
        .save_entries(&w.hr(), &k, replay.clone())
        .await
        .unwrap();
    let (b, fresh) = w.store.save_entries(&w.hr(), &k, replay).await.unwrap();
    assert_eq!((a.batch_id, fresh), (b.batch_id, false));
    assert_eq!(
        code(
            w.store
                .save_entries(&w.hr(), &k, save(vec![cell(&w, 1, TUE, "9-17")]))
                .await
        ),
        "idempotency_key_reused"
    );
    assert_eq!(rows(&w, "attendance_entries").await, 2);
}
