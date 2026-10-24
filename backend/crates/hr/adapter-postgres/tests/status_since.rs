// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Status labels start at the event that opened the interval, on both directory reads.

mod support;

use serde_json::json;
use sqlx::PgPool;
use support::{employee, no_filters, principal, tenant, user};

async fn assert_since(
    pool: &PgPool,
    status: &str,
    events: &[(&str, &str, &str, &str)],
    expected: &str,
) {
    let t = tenant(pool).await;
    let employee = employee(pool, t.org, "김기준", "TIME-1", status).await;
    let actor = user(pool, t.org, None).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(
        "UPDATE employees SET hire_date='2016-03-02', \
         exit_date=CASE WHEN employment_status='EXITED' THEN '2026-10-21' ELSE NULL END \
         WHERE id=$1",
    )
    .bind(employee)
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    for (kind, from, to, date) in events {
        sqlx::query(
            "INSERT INTO employee_lifecycle_events \
             (org_id,employee_id,event_type,from_status,to_status,effective_date, \
              leave_type,comment,created_by,state) \
             VALUES ($1,$2,$3,$4,$5,$6, \
               CASE WHEN $3='LEAVE_OF_ABSENCE' THEN 'PERSONAL' END,'기준일 회귀 검증',$7,'APPLIED')",
        )
        .bind(t.org)
        .bind(employee)
        .bind(kind)
        .bind(from)
        .bind(to)
        .bind(date)
        .bind(*actor.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let page =
        t.hr.list_employees(principal(t.org, actor), no_filters())
            .await
            .unwrap();
    assert_eq!(page.items.len(), 1);
    let detail =
        t.hr.employee_detail(principal(t.org, actor), employee)
            .await
            .unwrap();
    for row in [
        serde_json::to_value(&page.items[0]).unwrap(),
        serde_json::to_value(&detail.employee).unwrap(),
    ] {
        assert_eq!(row["status"], json!(status));
        assert_eq!(row["status_since"], json!(expected), "{row}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_employee_without_status_events_uses_the_hire_date(pool: PgPool) {
    assert_since(&pool, "ACTIVE", &[], "2016-03-02").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn leave_since_is_the_applied_leave_start(pool: PgPool) {
    assert_since(
        &pool,
        "ON_LEAVE",
        &[("LEAVE_OF_ABSENCE", "ACTIVE", "ON_LEAVE", "2026-09-01")],
        "2026-09-01",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_transfer_does_not_restart_the_active_interval_opened_by_return(pool: PgPool) {
    assert_since(
        &pool,
        "ACTIVE",
        &[
            ("LEAVE_OF_ABSENCE", "ACTIVE", "ON_LEAVE", "2026-09-01"),
            ("RETURN_FROM_LEAVE", "ON_LEAVE", "ACTIVE", "2026-10-01"),
            ("TRANSFER", "ACTIVE", "ACTIVE", "2026-10-15"),
        ],
        "2026-10-01",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exited_since_is_the_first_non_employed_day_for_both_exit_events(pool: PgPool) {
    for kind in ["TERMINATE", "OFFBOARD"] {
        assert_since(
            &pool,
            "EXITED",
            &[(kind, "ACTIVE", "EXITED", "2026-10-21")],
            "2026-10-22",
        )
        .await;
    }
}
