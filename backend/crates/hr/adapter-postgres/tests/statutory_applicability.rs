#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::RecordFiling;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::principal;
use uuid::Uuid;
use world::{register_rules, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_automatic_exclusion_records_its_cited_ground_without_a_false_filing_date(
    pool: PgPool,
) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let rules = register_rules(&pool).await;
    for (insurer, reason, birth, patch) in [
        ("NPS", "AGE_LIMIT", "1960-01-01", json!({})),
        (
            "NPS",
            "MINOR_OPT_OUT",
            "2010-01-01",
            json!({"minor_opt_out":true}),
        ),
        (
            "NHIS",
            "SHORT_HOURS",
            "1990-01-01",
            json!({"monthly_hours":59}),
        ),
        (
            "NHIS",
            "DAILY_UNDER_MONTH",
            "1990-01-01",
            json!({"daily":true,"continuous_months":0}),
        ),
        (
            "EI",
            "DAILY_WORK_CONFIRMATION",
            "1990-01-01",
            json!({"daily":true}),
        ),
        (
            "NPS",
            "TREATY_EXCLUDED",
            "1990-01-01",
            json!({"foreign":true,"treaty":"EXCLUDED"}),
        ),
        (
            "EI",
            "VISA_EXCLUDED",
            "1990-01-01",
            json!({"foreign":true,"visa":"OPTIONAL_NOT_OPTED_IN"}),
        ),
        (
            "IACI",
            "EXECUTIVE_NOT_WORKER",
            "1990-01-01",
            json!({"director_without_worker_status":true}),
        ),
    ] {
        let event = Uuid::new_v4();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role=replica")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("UPDATE employees SET birth_date=$1::date WHERE id=$2")
            .bind(birth)
            .bind(w.employee)
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("INSERT INTO employee_lifecycle_events(org_id,id,employee_id,event_type,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,$3,'ONBOARD','ACTIVE','2026-09-01','hire',$4,'APPLIED')").bind(w.tenant.org).bind(event).bind(w.employee).bind(w.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
        tx.commit().await.unwrap();
        let mut facts = json!({"monthly_hours":160,"weekly_hours":40,"continuous_months":1,"daily":false,"foreign":false,"director_without_worker_status":false});
        facts
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let b: RecordFiling = serde_json::from_value(
            json!({"expected_version":0,"action":"ASSESS","applicability_facts":facts}),
        )
        .unwrap();
        let t = w
            .tenant
            .hr
            .record_insurance_filing(
                p.clone(),
                (event, "ACQUIRE".into(), insurer.into()),
                event.to_string(),
                b,
                rules.clone(),
            )
            .await
            .unwrap();
        assert_eq!(t.state, "NOT_APPLICABLE");
        assert_eq!(
            serde_json::to_value(t.not_applicable_reason).unwrap(),
            Value::String(reason.into())
        );
        assert!(t.completed_on.is_none());
        assert!(t.receipt_number.is_none());
        assert!(!t.basis.unwrap().applicability_citations.is_empty());
    }
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE org_id=$1 AND action='ASSESS' AND completed_on IS NULL").bind(w.tenant.org).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 8);
}
