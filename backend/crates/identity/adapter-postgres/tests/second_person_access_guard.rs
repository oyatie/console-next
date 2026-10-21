//! D0.2 over the 권한 screen's grants (155): the demotion guard covers an
//! access grant the requester revoked, and another tenant's holder never
//! counts.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod second_person_support;

use console_identity_adapter_postgres::second_person::SecondPersonQuery;
use console_kernel_core::UserId;
use console_platform_test_support::runtime_role_pool;
use second_person_support::access::{CLOSE, close, go_live, grant};
use second_person_support::{fact, holder, org};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_requester_who_revokes_the_other_holder_still_waits_for_them(owner: PgPool) {
    let runtime = runtime_role_pool(&owner).await;
    let requester = holder(&owner, None, &[], true, 400, true).await;
    let other = holder(&owner, None, &[], true, 400, true).await;
    let g = grant(&owner, org(), requester, other, CLOSE).await;
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_actor', $1, true)")
        .bind(requester.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE access_grants SET status = 'REVOKED', revoked_by = $2, revoked_at = now() WHERE id = $1",
    )
    .bind(g)
    .bind(requester)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    go_live(&owner, org(), requester).await;
    let got = fact(
        &runtime,
        &SecondPersonQuery {
            requester: UserId::from_uuid(requester),
            ..close()
        },
    )
    .await;
    assert_eq!(
        got.eligible,
        [other].into(),
        "the demotion guard keeps them: {got:?}"
    );
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn another_tenants_holder_never_counts(owner: PgPool) {
    let runtime = runtime_role_pool(&owner).await;
    let foreign = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Other')")
        .bind(foreign)
        .bind(format!("sp-{}", &foreign.simple().to_string()[..12]))
        .execute(&owner)
        .await
        .unwrap();
    let foreign_user = |name: &'static str| {
        let owner = owner.clone();
        async move {
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO users (display_name, roles, org_id) VALUES ($1, '{}', $2) RETURNING id",
            )
            .bind(name)
            .bind(foreign)
            .fetch_one(&owner)
            .await
            .unwrap()
        }
    };
    let (grantor, outsider) = (
        foreign_user("Grantor").await,
        foreign_user("Outsider").await,
    );
    grant(&owner, foreign, grantor, outsider, CLOSE).await;
    let requester = holder(&owner, None, &[], true, 400, true).await;
    go_live(&owner, org(), requester).await;
    go_live(&owner, foreign, grantor).await;
    let got = fact(
        &runtime,
        &SecondPersonQuery {
            requester: UserId::from_uuid(requester),
            ..close()
        },
    )
    .await;
    assert!(
        got.eligible.is_empty() && got.review_flags.is_empty(),
        "{got:?}"
    );
}
