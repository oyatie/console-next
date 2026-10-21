#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::FilingQuery;
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{
    Feature, Principal, Role,
    access::{NodeKind, ScopeGrant},
};
use sqlx::PgPool;
use std::collections::BTreeSet;
use support::principal;
use uuid::Uuid;
use world::{complete, list, register, register_rules, world};

async fn event(
    pool: &PgPool,
    w: &world::World,
    kind: &str,
    date: &str,
    voids: Option<Uuid>,
) -> Uuid {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state,voids_event_id) VALUES ($1,$2,$3,$4,'ACTIVE',$5,'event',$6,'APPLIED',$7)")
        .bind(w.tenant.org).bind(id).bind(w.employee).bind(kind).bind(date).bind(w.user.as_uuid()).bind(voids).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    id
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_leave_return_loss_codes_and_withdrawn_events_keep_truthful_clocks(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let leave = event(&pool, &w, "LEAVE_OF_ABSENCE", "2026-09-20", None).await;
    let resumed = event(&pool, &w, "RETURN_FROM_LEAVE", "2026-09-03", None).await;
    let loss = event(&pool, &w, "TERMINATE", "2026-09-30", None).await;
    let page = w
        .tenant
        .hr
        .insurance_filings(p.clone(), list(), register_rules(&pool).await)
        .await
        .unwrap();
    assert_eq!(page.total, 16);
    for t in page.items.iter().filter(|t| t.event_id == leave) {
        if ["EI", "IACI"].contains(&t.insurer.as_str()) {
            assert_eq!(t.due_date.as_deref(), Some("2026-10-04"));
        } else {
            assert_eq!(t.deadline_status, "UNKNOWN");
            assert!(t.due_date.is_none());
        }
    }
    assert!(
        page.items
            .iter()
            .filter(|t| t.event_id == resumed)
            .all(|t| t.due_date.is_none())
    );
    let health = page
        .items
        .iter()
        .find(|t| t.event_id == loss && t.insurer == "NHIS")
        .unwrap();
    assert_eq!(health.due_on.as_deref(), Some("2026-10-14"));
    assert_eq!(
        health
            .dates
            .as_ref()
            .unwrap()
            .legal_latest_candidate
            .as_deref(),
        Some("2026-10-15")
    );
    let ei = page
        .items
        .iter()
        .find(|t| t.event_id == loss && t.insurer == "EI")
        .unwrap();
    assert!(!ei.loss_options.is_empty());
    let rules = register_rules(&pool).await;
    let write = |b| {
        w.tenant.hr.record_insurance_filing(
            p.clone(),
            (loss, "LOSE".into(), "EI".into()),
            Uuid::new_v4().to_string(),
            b,
            rules.clone(),
        )
    };
    let mut b = complete(0);
    b.completed_on = Some("2026-10-01".into());
    let e = write(b).await.unwrap_err();
    assert_eq!(
        (e.status.as_u16(), e.code),
        (422, "filing_remuneration_required")
    );
    let audit: serde_json::Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='insurance_filing.refused' ORDER BY occurred_at DESC LIMIT 1")
        .bind(w.tenant.org).fetch_one(&pool).await.unwrap();
    assert_eq!(audit["code"], "filing_remuneration_required");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE event_id=$1")
            .bind(loss)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let mut b = complete(0);
    b.completed_on = Some("2026-10-01".into());
    b.total_remuneration_won = Some(1_000_000);
    assert_eq!(write(b).await.unwrap_err().code, "filing_record_invalid");
    let mut b = complete(0);
    b.completed_on = Some("2026-10-01".into());
    b.total_remuneration_won = Some(1_000_000);
    b.loss_code = Some("unknown".into());
    assert_eq!(write(b).await.unwrap_err().code, "filing_record_invalid");
    let option = ei.loss_options.iter().find(|o| o.requires_detail).unwrap();
    let mut b = complete(0);
    b.completed_on = Some("2026-10-01".into());
    b.total_remuneration_won = Some(1_000_000);
    b.loss_code = Some(option.code.clone());
    assert_eq!(write(b).await.unwrap_err().code, "filing_record_invalid");
    let mut b = complete(0);
    b.completed_on = Some("2026-10-01".into());
    b.loss_code = Some(option.code.clone());
    b.detail = Some("Actual filed reason".into());
    b.total_remuneration_won = Some(1_000_000);
    write(b).await.unwrap();
    event(&pool, &w, "RESCIND", "2026-10-02", Some(loss)).await;
    assert_eq!(
        w.tenant
            .hr
            .insurance_filings(p.clone(), list(), register_rules(&pool).await)
            .await
            .unwrap()
            .total,
        12
    );
    assert_eq!(
        write(complete(1)).await.unwrap_err().code,
        "filing_event_inactive"
    );
    let kept: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE event_id=$1")
            .bind(loss)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(kept, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_scoped_grants_cannot_read_or_write_another_workplace(pool: PgPool) {
    let w = world(&pool).await;
    let scoped = |site| {
        Principal::new(
            w.user,
            OrgId::from_uuid(w.tenant.org),
            BTreeSet::from([Role::Member]),
            BranchScope::All,
        )
        .with_scope_grants(vec![ScopeGrant {
            feature: Feature::EmployeeDirectoryManage,
            kind: NodeKind::Workplace,
            id: site,
        }])
    };
    assert_eq!(
        w.tenant
            .hr
            .insurance_filings(scoped(w.site), list(), register_rules(&pool).await)
            .await
            .unwrap()
            .total,
        4
    );
    assert_eq!(
        w.tenant
            .hr
            .statutory_workplaces(scoped(w.site), None)
            .await
            .unwrap()
            .len(),
        1
    );
    let wrong = scoped(Uuid::new_v4());
    assert!(
        w.tenant
            .hr
            .statutory_workplaces(wrong.clone(), None)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        w.tenant
            .hr
            .insurance_filings(wrong.clone(), list(), register_rules(&pool).await)
            .await
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        w.tenant
            .hr
            .worker_register(wrong.clone(), register(w.site, "2026-09-02"))
            .await
            .unwrap_err()
            .code,
        "out_of_scope"
    );
    let err = w
        .tenant
        .hr
        .record_insurance_filing(
            wrong,
            (w.event, "ACQUIRE".into(), "NPS".into()),
            "scope".into(),
            complete(0),
            register_rules(&pool).await,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "filing_event_inactive");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_keyset_pages_keep_every_insurer_on_same_date_events(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    // Many same-date events exercise all cursor tie breakers without fixture auth shortcuts in the read.
    for _ in 0..52 {
        event(&pool, &w, "RETURN_FROM_LEAVE", "2026-09-03", None).await;
    }
    let mut q = FilingQuery {
        limit: Some(37),
        ..list()
    };
    let mut seen = BTreeSet::new();
    loop {
        let page = w
            .tenant
            .hr
            .insurance_filings(p.clone(), q, register_rules(&pool).await)
            .await
            .unwrap();
        assert_eq!(page.total, 212);
        for t in page.items {
            assert!(seen.insert((t.event_id, t.kind, t.insurer)));
        }
        match page.next {
            Some(after) => {
                q = FilingQuery {
                    after: Some(after),
                    limit: Some(37),
                    ..list()
                }
            }
            None => break,
        }
    }
    assert_eq!(seen.len(), 212);
}
