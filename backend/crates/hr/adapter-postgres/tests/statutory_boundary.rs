// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
mod support;
#[path = "support/trail_queries.rs"]
mod trail_queries;
#[path = "statutory/world.rs"]
mod world;
use console_compliance_domain::statutory::filing::{FilingAnchors, FilingRule, dates};
use console_hr_adapter_postgres::statutory::FilingQuery;
use serde_json::json;
use sqlx::PgPool;
use time::Date;
use tracing::instrument::WithSubscriber;

// SQLx setup also runs SQL; one harness keeps process-global tracing interest stable.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_boundaries_and_requested_acquisition_share_the_clock(pool: PgPool) {
    boundary(pool.clone(), "DAYS", "INCLUDED", "UNVERIFIED", 1).await;
    boundary(
        pool.clone(),
        "DAY_OF_NEXT_MONTH",
        "EXCLUDED",
        "CIVIL_CODE161",
        15,
    )
    .await;
    boundary(pool.clone(), "DAYS", "EXCLUDED", "CIVIL_CODE161", 4).await;
    requested_acquisition_uses_its_register_clock_across_go_live(pool).await;
}
async fn boundary(pool: PgPool, kind: &str, first: &str, holiday: &str, value: i32) {
    let w = world::world(&pool).await;
    let on = Date::from_calendar_date(2026, time::Month::September, 1).unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE statutory_rules SET filing_rule=jsonb_set(jsonb_set(filing_rule,'{deadline}',$1),'{holiday_roll}',$2) WHERE code='ins.deadline.acquire.nhis'")
        .bind(json!({"anchor":"ACQUIRE_DATE","kind":kind,"value":value,"first_day":first})).bind(json!(holiday)).execute(tx.as_mut()).await.unwrap();
    let raw:serde_json::Value=sqlx::query_scalar("SELECT filing_rule FROM statutory_rules WHERE code='ins.deadline.acquire.nhis' ORDER BY effective_from DESC LIMIT 1")
        .fetch_one(tx.as_mut()).await.unwrap();
    let rule: FilingRule = serde_json::from_value(raw).unwrap();
    let anchors = FilingAnchors {
        acquire_date: Some(on),
        effective_date: Some(on),
        ..Default::default()
    };
    let before = console_hr_domain::text::parse_yyyy_mm_dd(
        &dates(&rule, &anchors, &[]).unwrap().due_on.unwrap(),
    )
    .unwrap();
    let go_live = before.next_day().unwrap();
    sqlx::query("UPDATE tenant_phase SET go_live_at=$2::date::timestamp AT TIME ZONE lifecycle_time_zone($1,$3,$2,$4) + interval '12 hours' WHERE org_id=$1")
        .bind(w.tenant.org).bind(go_live).bind(w.employee).bind(w.site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("UPDATE employee_lifecycle_events SET effective_date=$3::date::text WHERE org_id=$1 AND id=$2")
        .bind(w.tenant.org).bind(w.event).bind(go_live).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events(org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state,created_at) SELECT $1,$2,'ONBOARD','ACTIVE',$3::date::text,'boundary hire',$4,'APPLIED',(SELECT created_at-interval '1 second' FROM employee_lifecycle_events WHERE org_id=$1 AND id=$5) FROM generate_series(1,60)")
        .bind(w.tenant.org).bind(w.employee).bind(on).bind(w.user.as_uuid()).bind(w.event).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let p = support::principal(w.tenant.org, w.user);
    for (delta, visible) in [(0, false), (7, true)] {
        sqlx::query("UPDATE statutory_rules SET filing_rule=jsonb_set(filing_rule,'{deadline,value}',to_jsonb($1::int)) WHERE code='ins.deadline.acquire.nhis'")
            .bind(value+delta).execute(&pool).await.unwrap();
        let register = world::register_rules(&pool).await;
        let changed = register
            .filing_rule("NHIS", "ACQUIRE", on)
            .unwrap()
            .unwrap();
        let due = dates(changed, &anchors, &[]).unwrap().due_on.unwrap();
        let queries = trail_queries::Queries::default();
        let (page, exact) = w
            .tenant
            .hr
            .insurance_inbox_page(
                p.clone(),
                FilingQuery {
                    insurer: Some("NHIS".into()),
                    kind: Some("ACQUIRE".into()),
                    limit: Some(50),
                    ..Default::default()
                },
                register,
                None,
            )
            .with_subscriber(queries.clone())
            .await
            .unwrap();
        assert_eq!(
            queries
                .statements()
                .iter()
                .filter(|s| s.contains("array_agg(inbox_id)"))
                .count(),
            1,
            "SQL must exclude pre-console candidates using the shared clock"
        );
        if visible {
            assert!(exact);
            assert_eq!(page.items.len(), 50);
            assert!(
                page.items
                    .iter()
                    .all(|r| r.due_on.as_deref() == Some(due.as_str()))
            );
        } else {
            assert!(exact);
            assert_eq!(page.items.len(), 1);
            assert_eq!(page.items[0].event_id, w.event);
        }
    }
}

async fn requested_acquisition_uses_its_register_clock_across_go_live(pool: PgPool) {
    let w = world::world(&pool).await;
    let mut setup = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(setup.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE tenant_phase SET go_live_at='2026-10-01' WHERE org_id=$1")
        .bind(w.tenant.org)
        .execute(setup.as_mut())
        .await
        .unwrap();
    setup.commit().await.unwrap();
    sqlx::query("UPDATE statutory_rules SET filing_rule=jsonb_set(filing_rule,'{deadline}',$1) WHERE code='ins.deadline.acquire.ei'")
        .bind(json!({"anchor":"ACQUIRE_DATE","kind":"DAYS","value":1,"first_day":"INCLUDED"})).execute(&pool).await.unwrap();
    sqlx::query("UPDATE statutory_rules SET filing_rule=jsonb_set(filing_rule,'{deadline}',$1) WHERE code='ins.filing.acquire_requested.ei'")
        .bind(json!({"anchor":"REQUEST_DATE","kind":"DAYS","value":500,"first_day":"EXCLUDED"})).execute(&pool).await.unwrap();
    let query = FilingQuery {
        event_id: Some(w.event),
        insurer: Some("EI".into()),
        kind: Some("ACQUIRE".into()),
        ..Default::default()
    };
    let p = support::principal(w.tenant.org, w.user);
    let (page, _) = w
        .tenant
        .hr
        .insurance_inbox_page(
            p.clone(),
            query.clone(),
            world::register_rules(&pool).await,
            None,
        )
        .await
        .unwrap();
    assert!(page.items.is_empty());
    sqlx::query("INSERT INTO insurance_filing_requests(org_id,employee_id,source_event_id,filing_kind,anchor_on,actor,idempotency_key,request_hash) VALUES($1,$2,$3,'ACQUIRE_REQUESTED','2026-09-02',$4,'boundary-request',repeat('0',64))")
        .bind(w.tenant.org).bind(w.employee).bind(w.event).bind(w.user.as_uuid()).execute(&pool).await.unwrap();
    let register = world::register_rules(&pool).await;
    let requested_on = Date::from_calendar_date(2026, time::Month::September, 2).unwrap();
    let rule = register
        .filing_rule("EI", "ACQUIRE_REQUESTED", requested_on)
        .unwrap()
        .unwrap();
    let expected = dates(
        rule,
        &FilingAnchors {
            acquire_date: Some(requested_on.previous_day().unwrap()),
            request_date: Some(requested_on),
            ..Default::default()
        },
        &[],
    )
    .unwrap();
    let (page, _) = w
        .tenant
        .hr
        .insurance_inbox_page(p, query, register, None)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].due_on, expected.due_on);
}
