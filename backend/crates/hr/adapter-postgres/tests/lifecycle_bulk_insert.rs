// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/lifecycle_grant.rs"]
mod lifecycle_grant;
#[allow(dead_code)]
#[path = "support/trail_queries.rs"]
mod trail_queries;

use console_hr_adapter_postgres::clock::today_kst;
use serde_json::json;
use sqlx::PgPool;
use time::Duration;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_ledger_is_one_insert_with_exact_audits_cases_and_replay(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let foreign = fixture::fixture(pool.clone()).await;
    lifecycle_grant::grant(
        &pool,
        *f.principal.org_id.as_uuid(),
        *f.principal.user_id.as_uuid(),
    )
    .await;
    let mut ids = Vec::new();
    for n in 0..3 {
        let mut body = f.body(&format!("ledger-{n}"), "REGULAR");
        body.name = format!("합성 직원 {n}");
        body.hire_date = Some(today_kst().to_string());
        ids.push(f.create(body).await.unwrap().employee_id());
    }
    for scheduled in [false, true] {
        let on = today_kst() + Duration::days(if scheduled { 1 } else { 0 });
        let job = if scheduled { "검토" } else { "개발" };
        let body = json!({"event_type":"APPOINT","employee_ids":ids,"to_job":job,
            "effective_date":on.to_string(),"comment":"직무 발령"});
        let key = Uuid::new_v4().to_string();
        let queries = trail_queries::Queries::default();
        let result =
            f.hr.bulk_lifecycle_events(
                f.principal.clone(),
                key.clone(),
                serde_json::from_value(body.clone()).unwrap(),
            )
            .with_subscriber(queries.clone())
            .await
            .unwrap();
        assert_eq!(
            queries
                .statements()
                .iter()
                .filter(|s| s.contains("INSERT INTO employee_lifecycle_events"))
                .count(),
            1,
            "the product batch must share one ledger insert"
        );
        let batch: Uuid = serde_json::from_value(result["batch_id"].clone()).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 3);
        for item in result["items"].as_array().unwrap() {
            assert_eq!(
                item["state"],
                if scheduled { "SCHEDULED" } else { "APPLIED" }
            );
            assert_eq!(item["to_job"], job);
        }
        let replay =
            f.hr.bulk_lifecycle_events(
                f.principal.clone(),
                key,
                serde_json::from_value(body).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(replay, result);
        let rows: Vec<(Uuid, i64, i64)> = sqlx::query_as("SELECT l.employee_id,count(DISTINCT c.id),count(DISTINCT a.id) \
            FROM employee_lifecycle_events l \
            LEFT JOIN lifecycle_cases c ON c.org_id=l.org_id AND c.trigger_id=l.id \
            LEFT JOIN audit_events a ON a.org_id=l.org_id AND a.after_snap->>'lifecycle_event_id'=l.id::text \
                AND a.target_id=l.employee_id::text AND a.action=$3 AND a.actor=$4 \
            WHERE l.org_id=$1 AND l.batch_id=$2 GROUP BY l.employee_id")
            .bind(f.principal.org_id.as_uuid()).bind(batch)
            .bind(if scheduled { "employee.lifecycle.schedule" } else { "employee.lifecycle.record" })
            .bind(f.principal.user_id.as_uuid()).fetch_all(&pool).await.unwrap();
        assert_eq!(rows.len(), ids.len());
        for (employee, cases, audits) in rows {
            assert!(ids.contains(&employee));
            assert_eq!(
                (cases, audits),
                (1, 1),
                "each person keeps exactly one case and audit after replay"
            );
        }
        let mut tx = foreign.rt.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(foreign.principal.org_id.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let visible: i64 =
            sqlx::query_scalar("SELECT count(*) FROM employee_lifecycle_events WHERE batch_id=$1")
                .bind(batch)
                .fetch_one(tx.as_mut())
                .await
                .unwrap();
        assert_eq!(visible, 0);
        tx.rollback().await.unwrap();
    }
}
