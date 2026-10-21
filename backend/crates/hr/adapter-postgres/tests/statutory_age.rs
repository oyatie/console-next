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
use time::{Duration, OffsetDateTime, UtcOffset};
use uuid::Uuid;
use world::{complete, list, register_rules, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pension_age_loss_has_one_task_and_exact_birth_dates_stay_tenant_scoped(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let today = OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date();
    let birth = today.replace_year(today.year() - 60).unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET birth_date=$1 WHERE id=$2")
        .bind(birth)
        .bind(w.employee)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employee_lifecycle_events SET created_at=$1 WHERE id=$2")
        .bind(
            (today - Duration::days(20))
                .midnight()
                .assume_offset(UtcOffset::from_hms(9, 0, 0).unwrap()),
        )
        .bind(w.event)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let rules = register_rules(&pool).await;
    let query = || FilingQuery {
        kind: Some("AGE60".into()),
        ..list()
    };
    let before = w
        .tenant
        .hr
        .insurance_filings(
            p.clone(),
            FilingQuery {
                kind: Some("AGE60".into()),
                inbox_as_of: Some(
                    today
                        .midnight()
                        .assume_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
                        - Duration::seconds(1),
                ),
                ..list()
            },
            rules.clone(),
        )
        .await
        .unwrap();
    assert_eq!(before.total, 0);
    let page = w
        .tenant
        .hr
        .insurance_filings(p.clone(), query(), rules.clone())
        .await
        .unwrap();
    assert_eq!(page.total, 1);
    let t = &page.items[0];
    assert_eq!(t.insurer, "NPS");
    assert_eq!(
        t.created_at,
        today
            .midnight()
            .assume_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
    );
    assert_eq!(
        t.opens_on.as_deref(),
        Some((today + Duration::days(1)).to_string()).as_deref()
    );
    assert_eq!(t.target_on, t.opens_on);
    assert!(t.dates.as_ref().unwrap().conservative);
    let scoped = Principal::new(
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
        .insurance_filings(scoped.clone(), list(), rules.clone())
        .await
        .unwrap();
    assert_eq!(page.total, 4);
    let serialized = serde_json::to_value(&page).unwrap();
    assert!(!serialized.to_string().contains(&birth.to_string()));
    assert!(!serialized.to_string().contains("birth_date_for_assessment"));
    assert_eq!(
        w.tenant
            .hr
            .insurance_filings(scoped.clone(), query(), rules.clone())
            .await
            .unwrap()
            .total,
        0
    );
    let e = w
        .tenant
        .hr
        .record_insurance_filing(
            scoped,
            (w.event, "AGE60".into(), "NPS".into()),
            "age-scoped".into(),
            complete(0),
            rules.clone(),
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, "filing_event_inactive");
    let e = w
        .tenant
        .hr
        .record_insurance_filing(
            p.clone(),
            (w.event, "AGE60".into(), "NPS".into()),
            "age-early".into(),
            complete(0),
            rules,
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, "filing_record_invalid");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE org_id=$1")
            .bind(w.tenant.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events(org_id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,'TERMINATE','EXITED',$3,'approved ending awaiting worker',$4,'SCHEDULED')").bind(w.tenant.org).bind(w.employee).bind((today-Duration::days(1)).to_string()).bind(w.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        w.tenant
            .hr
            .insurance_filings(p, query(), register_rules(&pool).await)
            .await
            .unwrap()
            .total,
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_rehire_opens_at_its_own_acquisition_and_refuses_an_earlier_filing(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let on = OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
        + Duration::days(40);
    let event = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events(org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,$3,'REHIRE','ACTIVE',$4,'rehire',$5,'SCHEDULED')").bind(w.tenant.org).bind(event).bind(w.employee).bind(on.to_string()).bind(w.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let rules = register_rules(&pool).await;
    let page = w
        .tenant
        .hr
        .insurance_filings(
            p.clone(),
            FilingQuery {
                event_id: Some(event),
                ..list()
            },
            rules.clone(),
        )
        .await
        .unwrap();
    assert_eq!(page.total, 4);
    for t in &page.items {
        assert_eq!(t.opens_on.as_deref(), Some(on.to_string()).as_deref());
        assert_eq!(t.target_on, t.opens_on);
    }
    let e = w
        .tenant
        .hr
        .record_insurance_filing(
            p,
            (event, "ACQUIRE".into(), "NPS".into()),
            "early".into(),
            complete(0),
            rules,
        )
        .await
        .unwrap_err();
    assert_eq!(e.code, "filing_record_invalid");
}
