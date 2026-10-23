// SPDX-License-Identifier: LicenseRef-Proprietary
//! The same current-holder port used by HR and onboarding, under runtime RLS.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod second_person_support;

use console_identity_adapter_postgres::second_person::{HolderCapability, PgHolderResolver};
use console_identity_application::holders::HolderResolver;
use console_kernel_core::OrgId;
use console_platform_test_support::runtime_role_pool;
use second_person_support::access::{CLOSE, Grant, go_live, grant};
use second_person_support::{holder, org};
use sqlx::PgPool;
use time::OffsetDateTime;

async fn resolve_access_admins(
    pool: &PgPool,
    now: OffsetDateTime,
) -> std::collections::BTreeSet<uuid::Uuid> {
    let runtime = runtime_role_pool(pool).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    PgHolderResolver {
        tx: &mut tx,
        org: OrgId::one(),
        capability: HolderCapability::AccessAdmin,
        exclude_account: None,
        exclude_employee: None,
        include_ops: false,
        now,
    }
    .resolve()
    .await
    .unwrap()
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn two_holders_one_revoked_counts_one_and_stays_tenant_scoped(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let by = holder(&pool, None, &[], false, 400, true).await;
    let a = holder(&pool, None, &[], true, 400, true).await;
    let b = holder(&pool, None, &[], true, 400, true).await;
    let spec = Grant {
        domain: "org",
        level: "approve",
        ..CLOSE
    };
    grant(&pool, org(), by, a, spec).await;
    let gone = grant(&pool, org(), by, b, spec).await;
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE id=$1",
    )
    .bind(gone)
    .bind(by)
    .execute(&pool)
    .await
    .unwrap();
    go_live(&pool, org(), by).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let mut resolver = PgHolderResolver {
        tx: &mut tx,
        org: OrgId::one(),
        capability: HolderCapability::OrgChangeDecide,
        exclude_account: None,
        exclude_employee: None,
        include_ops: false,
        now: OffsetDateTime::now_utc(),
    };
    assert_eq!(resolver.resolve().await.unwrap(), [a].into());
    resolver.org = OrgId::new();
    assert!(resolver.resolve().await.unwrap().is_empty());
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn inactive_user_does_not_count_as_a_current_holder(pool: PgPool) {
    let by = holder(&pool, None, &[], false, 400, true).await;
    let active = holder(&pool, None, &[], true, 400, true).await;
    let inactive = holder(&pool, None, &[], true, 400, true).await;
    for account in [active, inactive] {
        grant(
            &pool,
            org(),
            by,
            account,
            Grant {
                domain: "access",
                level: "edit",
                ..CLOSE
            },
        )
        .await;
    }
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(inactive)
        .execute(&pool)
        .await
        .unwrap();
    go_live(&pool, org(), by).await;
    assert_eq!(
        resolve_access_admins(&pool, OffsetDateTime::now_utc()).await,
        [active].into()
    );
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn future_grant_does_not_count_as_a_current_holder(pool: PgPool) {
    let by = holder(&pool, None, &[], false, 400, true).await;
    let active = holder(&pool, None, &[], true, 400, true).await;
    let future = holder(&pool, None, &[], true, 400, true).await;
    let template = grant(
        &pool,
        org(),
        by,
        active,
        Grant {
            domain: "access",
            level: "edit",
            ..CLOSE
        },
    )
    .await;
    let now = OffsetDateTime::now_utc();
    sqlx::query(
        "INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,change_mode,reason_code,granted_by)
         SELECT org_id,$2,role_id,scope_kind,$3,change_mode,reason_code,granted_by FROM access_grants WHERE id=$1",
    )
        .bind(template)
        .bind(future)
        .bind(now + time::Duration::days(1))
        .execute(&pool)
        .await
        .unwrap();
    go_live(&pool, org(), by).await;
    assert_eq!(resolve_access_admins(&pool, now).await, [active].into());
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn ended_grant_does_not_count_as_a_current_holder(pool: PgPool) {
    let by = holder(&pool, None, &[], false, 400, true).await;
    let active = holder(&pool, None, &[], true, 400, true).await;
    let ended = holder(&pool, None, &[], true, 400, true).await;
    for account in [active, ended] {
        grant(
            &pool,
            org(),
            by,
            account,
            Grant {
                domain: "access",
                level: "edit",
                ..CLOSE
            },
        )
        .await;
    }
    let now = OffsetDateTime::now_utc();
    sqlx::query("UPDATE access_grants SET valid_to=$2 WHERE account_id=$1")
        .bind(ended)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
    go_live(&pool, org(), by).await;
    assert_eq!(resolve_access_admins(&pool, now).await, [active].into());
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn retired_role_does_not_count_as_a_current_holder(pool: PgPool) {
    let by = holder(&pool, None, &[], false, 400, true).await;
    let active = holder(&pool, None, &[], true, 400, true).await;
    let retired = holder(&pool, None, &[], true, 400, true).await;
    grant(
        &pool,
        org(),
        by,
        active,
        Grant {
            domain: "access",
            level: "edit",
            ..CLOSE
        },
    )
    .await;
    let retired_grant = grant(
        &pool,
        org(),
        by,
        retired,
        Grant {
            domain: "access",
            level: "edit",
            ..CLOSE
        },
    )
    .await;
    sqlx::query("UPDATE access_roles SET status='RETIRED' WHERE id=(SELECT role_id FROM access_grants WHERE id=$1)")
        .bind(retired_grant)
        .execute(&pool)
        .await
        .unwrap();
    go_live(&pool, org(), by).await;
    assert_eq!(
        resolve_access_admins(&pool, OffsetDateTime::now_utc()).await,
        [active].into()
    );
}

#[path = "holder_resolver/batch.rs"]
mod batch;
