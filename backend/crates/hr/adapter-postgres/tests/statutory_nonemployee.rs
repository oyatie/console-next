// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;

use console_hr_adapter_postgres::statutory::RegisterQuery;
use sqlx::PgPool;
use std::collections::BTreeSet;
use support::{employee, principal};
use uuid::Uuid;
use world::{list, register, register_rules, world};

// Direct SQL fixture: the employment profile write API path is not under test here.
async fn set_employment_type(
    pool: &PgPool,
    org_id: Uuid,
    employee_id: Uuid,
    employment_type: &str,
    actor: Uuid,
) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, \
         phone_e164, base_pay, idempotency_key, request_hash, created_by) \
         VALUES ($1, $2, $3, '+821012345678', 0, $4, repeat('a', 64), $5)",
    )
    .bind(employee_id)
    .bind(org_id)
    .bind(employment_type)
    .bind(format!("profile-{employee_id}"))
    .bind(actor)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn assert_excluded(pool: &PgPool, employment_type: &str) {
    let w = world(pool).await;
    set_employment_type(
        pool,
        w.tenant.org,
        w.employee,
        employment_type,
        *w.user.as_uuid(),
    )
    .await;
    let p = principal(w.tenant.org, w.user);
    let hr = &w.tenant.hr;

    let filings = hr
        .insurance_filings(p.clone(), list(), register_rules(pool).await)
        .await
        .unwrap();
    assert_eq!(filings.total, 0);
    assert!(filings.items.is_empty());

    let reg = hr
        .worker_register(p, register(w.site, "2026-09-02"))
        .await
        .unwrap();
    assert_eq!(reg.total, 0);
    assert!(reg.items.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn dispatched_in_is_excluded_from_filings_and_worker_register(pool: PgPool) {
    assert_excluded(&pool, "DISPATCHED_IN").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn outsourced_on_site_is_excluded_from_filings_and_worker_register(pool: PgPool) {
    assert_excluded(&pool, "OUTSOURCED_ON_SITE").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn freelance_is_excluded_from_filings_and_worker_register(pool: PgPool) {
    assert_excluded(&pool, "FREELANCE").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regular_and_null_profile_employees_remain_in_filings_and_worker_register(pool: PgPool) {
    // 1. No profile row at all (NULL guard).
    let w_null = world(&pool).await;
    let p_null = principal(w_null.tenant.org, w_null.user);
    let filings_null = w_null
        .tenant
        .hr
        .insurance_filings(p_null.clone(), list(), register_rules(&pool).await)
        .await
        .unwrap();
    assert_eq!((filings_null.total, filings_null.pending), (4, 4));
    assert_eq!(
        filings_null
            .items
            .iter()
            .filter(|t| t.kind == "ACQUIRE")
            .map(|t| t.insurer.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["EI", "IACI", "NHIS", "NPS"])
    );
    let reg_null = w_null
        .tenant
        .hr
        .worker_register(p_null, register(w_null.site, "2026-09-02"))
        .await
        .unwrap();
    assert_eq!(reg_null.total, 1);
    assert_eq!(reg_null.items.len(), 1);
    assert_eq!(reg_null.items[0].employee_id, w_null.employee);

    // 2. REGULAR profile.
    let w_reg = world(&pool).await;
    set_employment_type(
        &pool,
        w_reg.tenant.org,
        w_reg.employee,
        "REGULAR",
        *w_reg.user.as_uuid(),
    )
    .await;
    let p_reg = principal(w_reg.tenant.org, w_reg.user);
    let filings_reg = w_reg
        .tenant
        .hr
        .insurance_filings(p_reg.clone(), list(), register_rules(&pool).await)
        .await
        .unwrap();
    assert_eq!((filings_reg.total, filings_reg.pending), (4, 4));
    assert_eq!(
        filings_reg
            .items
            .iter()
            .filter(|t| t.kind == "ACQUIRE")
            .map(|t| t.insurer.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["EI", "IACI", "NHIS", "NPS"])
    );
    let reg_reg = w_reg
        .tenant
        .hr
        .worker_register(p_reg, register(w_reg.site, "2026-09-02"))
        .await
        .unwrap();
    assert_eq!(reg_reg.total, 1);
    assert_eq!(reg_reg.items.len(), 1);
    assert_eq!(reg_reg.items[0].employee_id, w_reg.employee);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn mixed_site_keeps_only_regular_employee_in_filings_and_worker_register(pool: PgPool) {
    let w = world(&pool).await;
    set_employment_type(
        &pool,
        w.tenant.org,
        w.employee,
        "REGULAR",
        *w.user.as_uuid(),
    )
    .await;

    let dispatched = employee(&pool, w.tenant.org, "Park", "D-1", "ACTIVE").await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET hire_on = '2026-09-01', hire_date = '2026-09-01', birth_date = '1990-01-01', job = 'HR' WHERE id = $1")
        .bind(dispatched)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'2026-09-01','MIGRATION',gen_random_uuid())")
        .bind(w.tenant.org)
        .bind(dispatched)
        .bind(w.entity)
        .bind(w.site)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,$3,'ONBOARD','ACTIVE','2026-09-01','hire',$4,'APPLIED')")
        .bind(w.tenant.org)
        .bind(Uuid::new_v4())
        .bind(dispatched)
        .bind(w.user.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    set_employment_type(
        &pool,
        w.tenant.org,
        dispatched,
        "DISPATCHED_IN",
        *w.user.as_uuid(),
    )
    .await;

    let p = principal(w.tenant.org, w.user);
    let filings = w
        .tenant
        .hr
        .insurance_filings(p.clone(), list(), register_rules(&pool).await)
        .await
        .unwrap();
    assert_eq!(filings.total, 4);
    assert!(filings.items.iter().all(|t| t.employee_id == w.employee));

    let reg = w
        .tenant
        .hr
        .worker_register(
            p,
            RegisterQuery {
                workplace_id: w.site,
                as_of: "2026-09-02".into(),
                after: None,
                limit: Some(10),
            },
        )
        .await
        .unwrap();
    assert_eq!(reg.total, 1);
    assert_eq!(reg.items.len(), 1);
    assert_eq!(reg.items[0].employee_id, w.employee);
}
