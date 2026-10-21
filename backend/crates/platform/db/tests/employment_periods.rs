#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! LC-B1 (migration 0313): two employments of one person never overlap
//! (`employment_overlap`), and the redefined head guard, rule by rule
//! (inter-entity-transfer.md §4.2 rules 1-4).

#[path = "lc_fixtures/mod.rs"]
mod lc_fixtures;

use lc_fixtures::{exec, head, person, refused, tenant};
use sqlx::PgPool;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn two_employments_of_one_person_never_overlap(pool: PgPool) {
    let t = tenant(&pool).await;
    let (a, b) = (person(&pool, &t, "a").await, person(&pool, &t, "b").await);
    head(&pool, &t, a, "2024-01-02", Some("2024-12-31"))
        .await
        .unwrap();
    // The last working day is inside the period: a second period may not start on it.
    let overlap = head(&pool, &t, a, "2024-12-31", None).await.unwrap_err();
    assert!(
        overlap.to_string().contains("employment_overlap"),
        "{overlap}"
    );
    let open = head(&pool, &t, a, "2024-06-01", None).await.unwrap_err();
    assert!(open.to_string().contains("employment_overlap"), "{open}");
    // The next day is a new period; another person's dates are their own.
    head(&pool, &t, a, "2025-01-01", None).await.unwrap();
    head(&pool, &t, b, "2024-06-01", None).await.unwrap();
    // An open period blocks every later start.
    let later = head(&pool, &t, a, "2026-01-01", None).await.unwrap_err();
    assert!(later.to_string().contains("employment_overlap"), "{later}");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn the_head_guard_admits_fills_corrections_while_unconfirmed_and_one_close(pool: PgPool) {
    let t = tenant(&pool).await;
    let (a, other) = (person(&pool, &t, "a").await, person(&pool, &t, "o").await);
    // Rule 1: a legacy head (0214 shape) is filled NULL -> value once.
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO employment_heads (org_id, valid_from) VALUES ($1, '2024-01-01T15:00:00Z') RETURNING id",
    )
    .bind(t.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    exec(
        &pool,
        "UPDATE employment_heads SET needs_confirmation = true WHERE id = $1",
        id,
    )
    .await
    .unwrap();
    let fill = sqlx::query(
        "UPDATE employment_heads SET employee_id = $2, hire_date = '2024-01-02', cause = 'MIGRATION', continuity = 'NEW' WHERE id = $1",
    )
    .bind(id)
    .bind(a)
    .execute(&pool)
    .await;
    assert!(fill.is_ok(), "{fill:?}");
    let swap = sqlx::query("UPDATE employment_heads SET employee_id = $2 WHERE id = $1")
        .bind(id)
        .bind(other)
        .execute(&pool)
        .await
        .unwrap_err();
    assert!(
        swap.to_string().contains("employment_head_immutable"),
        "{swap}"
    );
    // Rule 2: corrections while needs_confirmation; confirming freezes them.
    exec(
        &pool,
        "UPDATE employment_heads SET hire_date = '2024-01-03' WHERE id = $1",
        id,
    )
    .await
    .unwrap();
    exec(
        &pool,
        "UPDATE employment_heads SET needs_confirmation = false WHERE id = $1",
        id,
    )
    .await
    .unwrap();
    refused(
        exec(
            &pool,
            "UPDATE employment_heads SET hire_date = '2024-01-04' WHERE id = $1",
            id,
        )
        .await,
        "employment_head_immutable",
    );
    refused(
        exec(
            &pool,
            "UPDATE employment_heads SET needs_confirmation = true WHERE id = $1",
            id,
        )
        .await,
        "employment_head_immutable",
    );
    // Rule 3: the close is set once, valid_to aligned to exit_date + 1 (KST) by CHECK.
    refused(
        exec(&pool, "UPDATE employment_heads SET exit_date = '2024-06-30', valid_to = '2024-06-30T00:00:00Z' WHERE id = $1", id).await,
        "employment_heads_closed_window",
    );
    exec(
        &pool,
        "UPDATE employment_heads SET exit_date = '2024-06-30', \
                 valid_to = '2024-06-30T15:00:00Z', exit_reason_code = 'PERSONAL' WHERE id = $1",
        id,
    )
    .await
    .unwrap();
    refused(
        exec(
            &pool,
            "UPDATE employment_heads SET exit_date = '2024-07-31', \
                 valid_to = '2024-07-31T15:00:00Z' WHERE id = $1",
            id,
        )
        .await,
        "employment_head_immutable",
    );
    refused(
        exec(
            &pool,
            "UPDATE employment_heads SET exit_reason_code = 'FAMILY' WHERE id = $1",
            id,
        )
        .await,
        "employment_head_immutable",
    );
    // Rule 4: everything else, valid_from included.
    refused(
        exec(
            &pool,
            "UPDATE employment_heads SET valid_from = valid_from - interval '1 day' WHERE id = $1",
            id,
        )
        .await,
        "employment_head_immutable",
    );
    // An exit before the hire is not a period.
    refused(
        exec(
            &pool,
            "UPDATE employment_heads SET hire_date = '2024-01-05' WHERE id = $1",
            id,
        )
        .await,
        "employment_head_immutable",
    );
    let backwards = head(&pool, &t, other, "2024-05-01", Some("2024-04-30"))
        .await
        .unwrap_err();
    assert!(
        backwards
            .to_string()
            .contains("employment_heads_exit_after_hire"),
        "{backwards}"
    );
}
