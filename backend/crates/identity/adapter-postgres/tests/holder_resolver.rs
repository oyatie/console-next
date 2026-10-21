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
async fn grant_integrity_at_two_thousand_people_reports_elapsed_time(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    let by = holder(&pool, None, &[], false, 400, true).await;
    let account = holder(&pool, None, &[], true, 400, true).await;
    grant(
        &pool,
        org(),
        by,
        account,
        Grant {
            domain: "org",
            level: "approve",
            ..CLOSE
        },
    )
    .await;
    sqlx::query("INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key)
        SELECT $1, 'Synthetic', '부하 검증', 'fixture', 'fixture', n, gen_random_uuid()::text FROM generate_series(1,1999) n")
        .bind(org()).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO users (id,org_id,display_name,roles,employee_id)
        SELECT gen_random_uuid(), e.org_id, e.name, '{}', e.id FROM employees e WHERE e.org_id=$1
          AND NOT EXISTS(SELECT 1 FROM users u WHERE u.org_id=e.org_id AND u.employee_id=e.id)",
    )
    .bind(org())
    .execute(&pool)
    .await
    .unwrap();
    let people: i64 = sqlx::query_scalar("SELECT count(*) FROM employees WHERE org_id=$1")
        .bind(org())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(people, 2000);
    go_live(&pool, org(), by).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let result = PgHolderResolver {
        tx: &mut tx,
        org: OrgId::one(),
        capability: HolderCapability::OrgChangeDecide,
        exclude_account: None,
        exclude_employee: None,
        include_ops: false,
        now: OffsetDateTime::now_utc(),
    }
    .resolve()
    .await
    .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(result, [account].into());
    eprintln!(
        "F8 current-holder resolver, 2000 employees: {} us",
        elapsed.as_micros()
    );
    // The operator supplies the release budget; always emit the raw measurement.
    if let Ok(budget) = std::env::var("CONSOLE_TEST_GRANT_INTEGRITY_BUDGET_MS") {
        assert!(
            elapsed <= std::time::Duration::from_millis(budget.parse().unwrap()),
            "resolver exceeded the configured budget: {elapsed:?}"
        );
    }
}
