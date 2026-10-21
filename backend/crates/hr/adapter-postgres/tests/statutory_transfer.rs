#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::{FilingQuery, RequestFiling, RequestKind};
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_transfer_keeps_both_employers_scoped_and_receipt_versions_independent(
    pool: PgPool,
) {
    let w = world(&pool).await;
    let (entity, site, event) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(w.tenant.org).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,$2,$3,true,'MIGRATION')")
        .bind(w.tenant.org).bind(site).bind(entity).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO workplace_revisions (org_id,workplace_id,version,command_id,effective_from,name,status,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01','New site','CONTINUING','MIGRATION','test',sha256('x'::bytea),'{}')")
        .bind(w.tenant.org).bind(site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'2026-09-21','MIGRATION',gen_random_uuid())")
        .bind(w.tenant.org).bind(w.employee).bind(entity).bind(site).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,$3,'GROUP_TRANSFER','ACTIVE','2026-09-21','transfer',$4,'APPLIED')")
        .bind(w.tenant.org).bind(event).bind(w.employee).bind(w.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
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
    let rules = register_rules(&pool).await;
    let tasks = w
        .tenant
        .hr
        .insurance_filings(
            principal(w.tenant.org, w.user),
            FilingQuery {
                event_id: Some(event),
                ..list()
            },
            rules.clone(),
        )
        .await
        .unwrap();
    assert_eq!(tasks.total, 8);
    for task in &tasks.items {
        assert_eq!(
            (
                task.workplace_id,
                task.legal_entity_id,
                task.effective_date.as_str()
            ),
            if task.kind == "LOSE" {
                (Some(w.site), Some(w.entity), "2026-09-20")
            } else {
                (Some(site), Some(entity), "2026-09-21")
            }
        );
    }
    for t in tasks.items.iter().filter(|t| t.kind == "ACQUIRE") {
        assert_eq!(t.opens_on.as_deref(), Some("2026-09-21"));
    }
    for (place, expected, count) in [(w.site, "LOSE", 8), (site, "ACQUIRE", 4)] {
        let page = w
            .tenant
            .hr
            .insurance_filings(scoped(place), list(), rules.clone())
            .await
            .unwrap();
        assert_eq!(page.total, count);
        if place == w.site {
            assert_eq!(
                page.items.iter().filter(|t| t.event_id == w.event).count(),
                4
            );
        }
        assert!(
            page.items
                .iter()
                .filter(|t| t.event_id == event)
                .all(|t| t.kind == expected)
        );
    }
    let refused = w
        .tenant
        .hr
        .record_insurance_filing(
            scoped(w.site),
            (event, "ACQUIRE".into(), "NPS".into()),
            "wrong-employer".into(),
            complete(0),
            rules.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "filing_event_inactive")
    );
    for (place, kind) in [(w.site, "LOSE"), (site, "ACQUIRE")] {
        let mut body = complete(0);
        body.completed_on = Some("2026-09-21".into());
        if kind == "LOSE" {
            body.total_remuneration_won = Some(1_000_000);
        }
        if kind == "LOSE" {
            let option = tasks
                .items
                .iter()
                .find(|t| t.kind == kind && t.insurer == "EI")
                .unwrap()
                .loss_options
                .first()
                .unwrap();
            body.loss_code = Some(option.code.clone());
            if option.requires_detail {
                body.detail = Some("Actual filed reason".into());
            }
        }
        let saved = w
            .tenant
            .hr
            .record_insurance_filing(
                scoped(place),
                (event, kind.into(), "EI".into()),
                kind.into(),
                body,
                rules.clone(),
            )
            .await
            .unwrap();
        assert_eq!(saved.version, 1);
    }
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE event_id=$1")
            .bind(event)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rows, 2);
    let refused: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE target_id=$1 AND action='insurance_filing.refused'").bind(event.to_string()).fetch_one(&pool).await.unwrap();
    assert_eq!(refused, 1);
    for (place, on, count) in [
        (w.site, "2026-09-20", 1),
        (w.site, "2026-09-21", 0),
        (site, "2026-09-20", 0),
        (site, "2026-09-21", 1),
    ] {
        let page = w
            .tenant
            .hr
            .worker_register(principal(w.tenant.org, w.user), register(place, on))
            .await
            .unwrap();
        assert_eq!(page.total, count);
    }
    let certificate = w
        .tenant
        .hr
        .request_insurance_filing(
            scoped(w.site),
            "certificate".into(),
            RequestFiling {
                source_event_id: event,
                filing_kind: RequestKind::SeparationCertificate,
                anchor_on: "2026-09-22".into(),
            },
            rules.clone(),
        )
        .await
        .unwrap();
    assert_eq!(certificate.total, 1);
    let task = &certificate.items[0];
    assert_eq!(task.workplace_id, Some(w.site));
    assert_eq!(task.legal_entity_id, Some(w.entity));
    assert_eq!(task.due_on.as_deref(), Some("2026-10-02"));
    assert_eq!(
        w.tenant
            .hr
            .insurance_filings(
                scoped(site),
                FilingQuery {
                    event_id: Some(task.event_id),
                    ..list()
                },
                rules.clone()
            )
            .await
            .unwrap()
            .total,
        0
    );
    let refused = w
        .tenant
        .hr
        .request_insurance_filing(
            scoped(site),
            "new-employer-certificate".into(),
            RequestFiling {
                source_event_id: event,
                filing_kind: RequestKind::SeparationCertificate,
                anchor_on: "2026-09-23".into(),
            },
            rules,
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, "filing_event_inactive");
    let requests: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_requests WHERE org_id=$1")
            .bind(w.tenant.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(requests, 1);
}
