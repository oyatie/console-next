// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "account_link_solo/query_count.rs"]
mod query_count;
mod second_person_support;

use console_identity_adapter_postgres::account_link_solo::eligibility_in_tx;
use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_test_support::runtime_role_pool;
use second_person_support::access::{CLOSE, Grant, go_live, grant};
use second_person_support::{holder, org};
use sqlx::{ConnectOptions, PgPool};
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

async fn operator(pool: &PgPool) -> Uuid {
    let actor = holder(pool, None, &[], false, 0, false).await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(actor)
        .execute(pool)
        .await
        .unwrap();
    actor
}

async fn eligible(
    pool: &PgPool,
    tenant: OrgId,
    actor: Uuid,
    target: Uuid,
) -> Result<bool, KernelError> {
    measured_eligibility(pool, tenant, actor, target)
        .await
        .map(|(allowed, _)| allowed)
}

async fn measured_eligibility(
    pool: &PgPool,
    tenant: OrgId,
    actor: Uuid,
    target: Uuid,
) -> Result<(bool, usize), KernelError> {
    let logging_pool = PgPool::connect_with(
        pool.connect_options()
            .as_ref()
            .clone()
            .log_statements("Debug".parse().unwrap()),
    )
    .await
    .unwrap();
    let runtime = runtime_role_pool(&logging_pool).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(tenant.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let queries = query_count::QueryCount::default();
    let allowed = eligibility_in_tx(
        &mut tx,
        tenant,
        UserId::from_uuid(actor),
        UserId::from_uuid(target),
    )
    .with_subscriber(queries.clone())
    .await?;
    Ok((allowed, queries.get()))
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn foreign_operator_and_inactive_holder_do_not_prevent_the_offer(pool: PgPool) {
    let actor = operator(&pool).await;
    let foreign =
        console_platform_test_support::seed_org_and_super_admin(&pool, Uuid::new_v4(), "Foreign")
            .await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(foreign.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    assert!(eligible(&pool, OrgId::one(), actor, actor).await.unwrap());
    let second = holder(&pool, None, &[], false, 0, false).await;
    grant(
        &pool,
        org(),
        actor,
        second,
        Grant {
            domain: "access",
            level: "edit",
            ..CLOSE
        },
    )
    .await;
    go_live(&pool, org(), actor).await;
    assert!(!eligible(&pool, OrgId::one(), actor, actor).await.unwrap());
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(second)
        .execute(&pool)
        .await
        .unwrap();
    assert!(eligible(&pool, OrgId::one(), actor, actor).await.unwrap());
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_new_unbound_permission_holder_prevents_the_exception(pool: PgPool) {
    let actor = operator(&pool).await;
    let reviewer = holder(&pool, None, &[], false, 0, false).await;
    let grant_id = grant(
        &pool,
        org(),
        actor,
        reviewer,
        Grant {
            domain: "access",
            level: "edit",
            age_days: 0,
            notified: false,
            ..CLOSE
        },
    )
    .await;
    go_live(&pool, org(), actor).await;
    assert!(!eligible(&pool, OrgId::one(), actor, actor).await.unwrap());
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE id=$1",
    )
    .bind(grant_id)
    .bind(actor)
    .execute(&pool)
    .await
    .unwrap();
    assert!(eligible(&pool, OrgId::one(), actor, actor).await.unwrap());
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_permission_holder_effective_during_setup_prevents_the_exception(pool: PgPool) {
    let actor = operator(&pool).await;
    let reviewer = holder(&pool, None, &[], false, 0, false).await;
    let grant_id = grant(
        &pool,
        org(),
        actor,
        reviewer,
        Grant {
            domain: "access",
            level: "edit",
            ..CLOSE
        },
    )
    .await;
    assert!(eligible(&pool, OrgId::one(), actor, actor).await.unwrap());
    sqlx::query(
        "UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE id=$1",
    )
    .bind(grant_id)
    .bind(actor)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by)
        SELECT org_id,account_id,role_id,scope_kind,valid_from,true,'SETUP',reason_code,granted_by FROM access_grants WHERE id=$1")
        .bind(grant_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!eligible(&pool, OrgId::one(), actor, actor).await.unwrap());
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn another_account_non_operator_and_existing_binding_are_ineligible(pool: PgPool) {
    let actor = operator(&pool).await;
    let other = holder(&pool, None, &[], false, 0, false).await;
    assert!(!eligible(&pool, OrgId::one(), actor, other).await.unwrap());
    assert!(!eligible(&pool, OrgId::one(), other, other).await.unwrap());
    let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key)
        VALUES ($1,'Synthetic','Operator','fixture','fixture',1,gen_random_uuid()::text) RETURNING id")
        .bind(org()).fetch_one(&pool).await.unwrap();
    sqlx::query("UPDATE users SET employee_id=$2 WHERE id=$1")
        .bind(actor)
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    assert!(!eligible(&pool, OrgId::one(), actor, actor).await.unwrap());
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn tenant_rls_and_active_account_are_required(pool: PgPool) {
    let actor = operator(&pool).await;
    let mut owner_tx = pool.begin().await.unwrap();
    assert!(
        eligibility_in_tx(
            &mut owner_tx,
            OrgId::one(),
            UserId::from_uuid(actor),
            UserId::from_uuid(actor)
        )
        .await
        .is_err()
    );
    assert!(eligible(&pool, OrgId::new(), actor, actor).await.is_err());
    let inactive = holder(&pool, None, &[], false, 0, false).await;
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(inactive)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        eligible(&pool, OrgId::one(), inactive, inactive)
            .await
            .is_err()
    );
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn eligibility_at_two_thousand_employees_uses_set_based_holders(pool: PgPool) {
    let actor = operator(&pool).await;
    let (allowed, small_count) = measured_eligibility(&pool, OrgId::one(), actor, actor)
        .await
        .unwrap();
    assert!(allowed);
    assert!(
        small_count > 0,
        "query instrumentation must observe SQLx statements"
    );
    sqlx::query("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key)
        SELECT $1,'Synthetic','Load test','fixture','fixture',n,gen_random_uuid()::text FROM generate_series(1,2000) n")
        .bind(org()).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO users (org_id,display_name,roles,employee_id)
        SELECT org_id,name,'{}',id FROM employees WHERE org_id=$1",
    )
    .bind(org())
    .execute(&pool)
    .await
    .unwrap();
    let started = std::time::Instant::now();
    let (allowed, large_count) = measured_eligibility(&pool, OrgId::one(), actor, actor)
        .await
        .unwrap();
    assert!(allowed);
    assert_eq!(
        small_count, large_count,
        "employee count must not add queries"
    );
    eprintln!(
        "Solo eligibility, 2000 employees without grants: {:?}",
        started.elapsed()
    );
    let reviewer: Uuid =
        sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 AND id<>$2 LIMIT 1")
            .bind(org())
            .bind(actor)
            .fetch_one(&pool)
            .await
            .unwrap();
    let template = grant(
        &pool,
        org(),
        actor,
        reviewer,
        Grant {
            domain: "access",
            level: "edit",
            ..CLOSE
        },
    )
    .await;
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,change_mode,reason_code,granted_by)
        SELECT u.org_id,u.id,g.role_id,'TENANT',g.valid_from,'OPERATING','NEW_HIRE',$2
        FROM users u CROSS JOIN access_grants g WHERE g.id=$3 AND u.org_id=$1 AND u.id<>$2 AND u.id<>$4")
        .bind(org()).bind(actor).bind(template).bind(reviewer).execute(&pool).await.unwrap();
    go_live(&pool, org(), actor).await;
    let started = std::time::Instant::now();
    let (allowed, holder_count) = measured_eligibility(&pool, OrgId::one(), actor, actor)
        .await
        .unwrap();
    assert!(!allowed);
    assert_eq!(
        small_count, holder_count,
        "holder count must not add queries"
    );
    eprintln!(
        "Solo eligibility, 2000 employees with grants: {:?}",
        started.elapsed()
    );
    eprintln!(
        "Eligibility queries: solo={small_count}, 2000 employees={large_count}, 2000 holders={holder_count}"
    );
}
