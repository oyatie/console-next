// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/trail_queries.rs"]
mod trail_queries;

use sqlx::PgPool;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

fn observe() -> trail_queries::Queries {
    static DISPATCH: std::sync::OnceLock<tracing::Dispatch> = std::sync::OnceLock::new();
    DISPATCH.get_or_init(|| tracing::Dispatch::new(trail_queries::Queries::default()));
    trail_queries::Queries::default()
}

fn reference_reads(queries: &trail_queries::Queries) -> usize {
    queries
        .statements()
        .iter()
        .filter(|sql| sql.contains("WITH registration_refs"))
        .count()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_prepares_references_together_and_skips_them_on_replay(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let position = Uuid::new_v4();
    sqlx::query("INSERT INTO job_positions (org_id,id,org_unit_id) VALUES ($1,$2,$3)")
        .bind(f.principal.org_id.as_uuid())
        .bind(position)
        .bind(f.unit)
        .execute(&pool)
        .await
        .unwrap();
    let body = || {
        let mut body = f.body("prepared-create", "REGULAR");
        body.position = position.to_string();
        body
    };
    let queries = observe();
    let first = f
        .create(body())
        .with_subscriber(queries.clone())
        .await
        .unwrap();
    assert_eq!(
        reference_reads(&queries),
        1,
        "one reference read for branch, unit and position"
    );
    let queries = observe();
    let replay = f
        .create(body())
        .with_subscriber(queries.clone())
        .await
        .unwrap();
    assert_eq!(first.employee_id(), replay.employee_id());
    assert_eq!(
        reference_reads(&queries),
        0,
        "a replay needs no fresh references"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_preparation_preserves_reference_refusals_and_rolls_back_keys(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let other = fixture::fixture(pool.clone()).await;
    for field in ["branch", "unit", "legacy_unit", "position"] {
        let mut body = f.body(field, "REGULAR");
        let expected = match field {
            "branch" => {
                body.home_branch_id = Some(other.branch);
                404
            }
            "unit" => {
                body.org_unit_id = Some(other.unit);
                404
            }
            "legacy_unit" => {
                body.org_unit_id = None;
                body.org_unit = other.unit.to_string();
                422
            }
            _ => {
                body.position = Uuid::new_v4().to_string();
                422
            }
        };
        let queries = observe();
        let error = f
            .create(body)
            .with_subscriber(queries.clone())
            .await
            .unwrap_err();
        assert_eq!(error.status.as_u16(), expected, "{field}: {error:?}");
        assert_eq!(
            reference_reads(&queries),
            1,
            "{field}: one preparation reference read"
        );
    }
    sqlx::query("UPDATE branches SET deactivated_at=now() WHERE id=$1")
        .bind(f.branch)
        .execute(&pool)
        .await
        .unwrap();
    let error = f
        .create(f.body("inactive-branch", "REGULAR"))
        .await
        .unwrap_err();
    assert_eq!(error.status.as_u16(), 404);
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) \
        VALUES ($1,$2,2,gen_random_uuid(),$3,decode(repeat('00',32),'hex'), \
        '{\"name\":\"site\",\"kind\":\"site\",\"status\":\"dissolved\"}'::jsonb,'{}'::jsonb)")
        .bind(f.principal.org_id.as_uuid()).bind(f.unit).bind(f.principal.user_id.as_uuid())
        .execute(&pool).await.unwrap();
    let mut body = f.body("dissolved-unit", "REGULAR");
    body.home_branch_id = None;
    let error = f.create(body).await.unwrap_err();
    assert_eq!(error.status.as_u16(), 422);
    let reservations: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_create_idempotency WHERE org_id=$1")
            .bind(f.principal.org_id.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        reservations, 0,
        "a refused registration leaves no reserved key"
    );
}
