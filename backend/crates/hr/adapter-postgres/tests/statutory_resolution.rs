#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::{FilingQuery, RecordFiling};
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{
    Feature, Principal, Role,
    access::{NodeKind, ScopeGrant},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use support::principal;
use time::{Date, Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;
use world::{complete, list, register_rules, world};
fn today() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
}
fn not_applicable(reason: &str) -> RecordFiling {
    serde_json::from_value(json!({"expected_version":0,"action":"NOT_APPLICABLE","not_applicable_reason":reason,"detail":"Verified statutory exclusion and agency evidence"})).unwrap()
}
async fn event(pool: &PgPool, w: &world::World, date: Date, state: &str) -> Uuid {
    let id = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events(org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,$3,'TERMINATE','EXITED',$4,'exit',$5,$6)").bind(w.tenant.org).bind(id).bind(w.employee).bind(date.to_string()).bind(w.user.as_uuid()).bind(state).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    id
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn future_applied_and_approved_events_open_before_the_date_but_cannot_be_filed(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let due = today() + Duration::days(40);
    for state in ["APPLIED", "SCHEDULED"] {
        let id = event(&pool, &w, due, state).await;
        let page = w
            .tenant
            .hr
            .insurance_filings(
                p.clone(),
                FilingQuery {
                    event_id: Some(id),
                    ..list()
                },
                register_rules(&pool).await,
            )
            .await
            .unwrap();
        assert_eq!(page.total, 4);
        for t in page.items {
            assert_eq!(
                t.opens_on.as_deref(),
                Some((due + Duration::days(1)).to_string()).as_deref()
            );
            assert_eq!(t.target_on, t.opens_on);
            assert!(t.due_on.is_some());
            let error = w
                .tenant
                .hr
                .record_insurance_filing(
                    p.clone(),
                    (id, "LOSE".into(), t.insurer),
                    Uuid::new_v4().to_string(),
                    complete(0),
                    register_rules(&pool).await,
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "filing_record_invalid");
        }
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE org_id=$1")
            .bind(w.tenant.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn typed_not_applicable_has_no_filing_date_replays_and_undo_preserve_evidence(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let rules = register_rules(&pool).await;
    let record = |key: &str, body| {
        w.tenant.hr.record_insurance_filing(
            p.clone(),
            (w.event, "ACQUIRE".into(), "NPS".into()),
            key.to_owned(),
            body,
            rules.clone(),
        )
    };
    let bad = record("wrong-insurer", not_applicable("VISA_EXCLUDED"))
        .await
        .unwrap_err();
    assert_eq!(
        (bad.status.as_u16(), bad.code),
        (422, "filing_not_applicable_invalid")
    );
    let contradicted = record("contradicted-age", not_applicable("AGE_LIMIT"))
        .await
        .unwrap_err();
    assert_eq!(
        (contradicted.status.as_u16(), contradicted.code),
        (422, "filing_not_applicable_invalid")
    );
    let saved = record("not-applicable", not_applicable("OTHER_LEGAL_GROUND"))
        .await
        .unwrap();
    assert_eq!(saved.state, "NOT_APPLICABLE");
    assert!(saved.completed_on.is_none());
    assert!(saved.receipt_number.is_none());
    let replay = record("not-applicable", not_applicable("OTHER_LEGAL_GROUND"))
        .await
        .unwrap();
    assert_eq!(replay.version, 1);
    let mut false_date = not_applicable("AGE_LIMIT");
    false_date.completed_on = Some(today().to_string());
    assert_eq!(
        record("false-date", false_date).await.unwrap_err().code,
        "filing_record_invalid"
    );
    let undo = serde_json::from_value(json!({"expected_version":1,"action":"UNDO"})).unwrap();
    assert_eq!(record("undo", undo).await.unwrap().state, "PENDING");
    let rows:Vec<(String,Option<Date>,Option<String>)>=sqlx::query_as("SELECT action,completed_on,not_applicable_reason FROM insurance_filing_records WHERE event_id=$1 ORDER BY version").bind(w.event).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].2.as_deref(), Some("OTHER_LEGAL_GROUND"));
    assert!(rows.iter().all(|r| r.1.is_none()));
    let refused: Vec<Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='insurance_filing.refused'",
    )
    .bind(w.tenant.org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        refused
            .iter()
            .filter(|r| r["code"] == "filing_not_applicable_invalid")
            .count(),
        2
    );
    assert_eq!(
        refused
            .iter()
            .filter(|r| r["code"] == "filing_record_invalid")
            .count(),
        1
    );
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn employment_filing_covers_accident_without_a_second_filing_date(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let rules = register_rules(&pool).await;
    w.tenant
        .hr
        .record_insurance_filing(
            p.clone(),
            (w.event, "ACQUIRE".into(), "EI".into()),
            "ei".into(),
            complete(0),
            rules.clone(),
        )
        .await
        .unwrap();
    let page = w
        .tenant
        .hr
        .insurance_filings(p.clone(), list(), rules.clone())
        .await
        .unwrap();
    assert_eq!(page.pending, 2);
    let accident = page.items.iter().find(|t| t.insurer == "IACI").unwrap();
    assert_eq!(accident.state, "COVERED");
    assert!(accident.completed_on.is_none());
    let undo = serde_json::from_value(json!({"expected_version":1,"action":"UNDO"})).unwrap();
    w.tenant
        .hr
        .record_insurance_filing(
            p.clone(),
            (w.event, "ACQUIRE".into(), "EI".into()),
            "undo".into(),
            undo,
            rules.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        w.tenant
            .hr
            .insurance_filings(p, list(), rules)
            .await
            .unwrap()
            .pending,
        4
    );
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_filing_projection_masks_birth_date_and_refuses_sensitive_fact_capture(
    pool: PgPool,
) {
    let w = world(&pool).await;
    let p = Principal::new(
        w.user,
        OrgId::from_uuid(w.tenant.org),
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_scope_grants(vec![ScopeGrant {
        feature: Feature::EmployeeDirectoryManage,
        kind: NodeKind::Workplace,
        id: w.site,
    }]);
    let page = w
        .tenant
        .hr
        .insurance_filings(p.clone(), list(), register_rules(&pool).await)
        .await
        .unwrap();
    assert_eq!(page.total, 4);
    assert!(
        page.items
            .iter()
            .all(|t| t.applicability_facts.birth_date.is_none()
                && t.birth_date_known
                && !t.can_record_sensitive_facts)
    );
    let mut b = complete(0);
    b.applicability_facts.as_mut().unwrap().birth_date = Some("1990-01-01".into());
    let e = w
        .tenant
        .hr
        .record_insurance_filing(
            p,
            (w.event, "ACQUIRE".into(), "NPS".into()),
            "sensitive".into(),
            b,
            register_rules(&pool).await,
        )
        .await
        .unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (403, "scope_tenant_wide_only"));
    let audit:Value=sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='insurance_filing.refused' ORDER BY occurred_at DESC LIMIT 1").bind(w.tenant.org).fetch_one(&pool).await.unwrap();
    assert_eq!(audit["code"], "scope_tenant_wide_only");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE event_id=$1")
            .bind(w.event)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}
