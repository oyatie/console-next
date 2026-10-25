// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::FilingQuery;
use sqlx::PgPool;
use std::time::{Duration, Instant};
#[path = "support/trail_queries.rs"]
mod trail_queries;
use support::principal;
use tracing::instrument::WithSubscriber;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_pre_console_hires_do_not_rescan_before_the_pending_tail(pool: PgPool) {
    let w = world::world(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Historical hires precede the current go-live; the existing employee is the pending tail.
    sqlx::query("UPDATE tenant_phase SET go_live_at=now() WHERE org_id=$1")
        .bind(w.tenant.org)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let today: time::Date =
        sqlx::query_scalar("SELECT lifecycle_go_live_on($1,$2,current_date,$3)")
            .bind(w.tenant.org)
            .bind(w.employee)
            .bind(w.site)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    sqlx::query(
        "UPDATE employees SET hire_date=$3::date::text,hire_on=$3 WHERE org_id=$1 AND id=$2",
    )
    .bind(w.tenant.org)
    .bind(w.employee)
    .bind(today)
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query(
        "UPDATE employment_assignments SET valid_from=$3 WHERE org_id=$1 AND employee_id=$2",
    )
    .bind(w.tenant.org)
    .bind(w.employee)
    .bind(today)
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query("UPDATE employee_lifecycle_events SET effective_date=$3::date::text WHERE org_id=$1 AND id=$2")
        .bind(w.tenant.org).bind(w.event).bind(today).execute(tx.as_mut()).await.unwrap();
    let past = today - time::Duration::days(365);
    sqlx::query("INSERT INTO employees (org_id,company,name,employee_number,employment_status,source_filename,source_sheet,source_row,source_key,hire_date,hire_on) SELECT $1,'Test','Historical worker '||n,'PC-'||n,'ACTIVE','history.xlsx','Sheet',n,'pre-console-'||n,$2::date::text,$2 FROM generate_series(1,2000) n")
        .bind(w.tenant.org).bind(past).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) SELECT $1,id,$2,$3,$4,'MIGRATION',gen_random_uuid() FROM employees WHERE org_id=$1 AND source_key LIKE 'pre-console-%'")
        .bind(w.tenant.org).bind(w.entity).bind(w.site).bind(past).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state,created_at) SELECT $1,id,'ONBOARD','ACTIVE',$3::date::text,'historical hire',$2,'APPLIED',(SELECT created_at - interval '1 day' FROM employee_lifecycle_events WHERE org_id=$1 AND id=$4) FROM employees WHERE org_id=$1 AND source_key LIKE 'pre-console-%'")
        .bind(w.tenant.org).bind(w.user.as_uuid()).bind(past).bind(w.event).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let register = world::register_rules(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let mut elapsed = Vec::new();
    let queries = trail_queries::Queries::default();
    for _ in 0..20 {
        let started = Instant::now();
        let (page, exact) = tokio::time::timeout(
            Duration::from_secs(30),
            w.tenant
                .hr
                .insurance_inbox_page(
                    p.clone(),
                    FilingQuery {
                        state: Some("PENDING".into()),
                        limit: Some(50),
                        ..Default::default()
                    },
                    register.clone(),
                )
                .with_subscriber(queries.clone()),
        )
        .await
        .expect("historical candidates must be excluded before LIMIT")
        .unwrap();
        elapsed.push(started.elapsed());
        assert!(
            exact,
            "historical candidates must not require another SQL page"
        );
        assert_eq!((page.total, page.pending, page.items.len()), (4, 4, 4));
        assert!(page.next.is_none());
        assert!(page.items.iter().all(|item| item.event_id == w.event));
    }
    elapsed.sort();
    let p95 = elapsed[18];
    eprintln!("pre-console inbox: 2,000 people, 20 reads, p95={p95:?}");
    assert_eq!(
        queries.scans(),
        20,
        "each read must finish in one candidate page"
    );

    // Moving the register deadline must make the same historical hires visible.
    sqlx::query("UPDATE statutory_rules SET filing_rule=jsonb_set(filing_rule,'{deadline,value}','500') WHERE code='ins.deadline.acquire.nhis'")
        .execute(&pool).await.unwrap();
    let (page, exact) = w
        .tenant
        .hr
        .insurance_inbox_page(
            p,
            FilingQuery {
                state: Some("PENDING".into()),
                limit: Some(50),
                ..Default::default()
            },
            world::register_rules(&pool).await,
        )
        .await
        .unwrap();
    assert!(!exact);
    assert_eq!(page.items.len(), 50);
    assert!(page.next.is_some());
    assert!(page.items.iter().all(|item| {
        item.event_id != w.event
            && item.insurer == "NHIS"
            && item.due_in_days.is_some_and(|days| days > 0)
    }));
}
